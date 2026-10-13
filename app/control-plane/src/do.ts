// ReorderBuffer Durable Object: ONE INSTANCE PER CONNECTED COMPONENT (T14).
// The DO name is `comp-<rootEntryId>` (e.g. `comp-e1`); `ctx.id.name` is the
// component key. It feeds commands into the pure machine (src/rob.ts),
// persists the returned state, executes effects through ports (src/ports.ts)
// and relays ArbEvents to the ArbRouter DO for /api/ws fan-in. Retirement
// effects are delegated to the ArbTrunk DO, which serializes all trunk
// mutations across components.

import { DurableObject } from "cloudflare:workers";
import {
	apply,
	rebuildIndexes,
	initialState,
	publicState,
	type ArbEvent,
	type Cmd,
	type Effect,
	type RobState,
} from "./rob.ts";
import {
	mergeSourceMap,
	realArtifacts,
	realChecker,
	realHasher,
	realJev,
	type Ports,
	type SourceRecord,
	type SourceStorePort,
	type TrunkRetirerPort,
} from "./ports.ts";
import {
	execEffects,
	interfaceToMaps,
	pushCommand,
	tokenCache,
	TOKEN_TTL_S,
	type EffectHost,
	type EffectResults,
	type TokenCache,
} from "./effects.ts";
import { errorText } from "../../checker/src/retry.ts";
import { ROUTER_NAME } from "./router.ts";
import { componentFromInstance } from "./shard.ts";
import { TRUNK_NAME, type ArbTrunk } from "./trunk.ts";
import type { ArbRouter } from "./router.ts";

const STATE_KEY = "state";

export interface Env {
	ARTIFACTS: unknown;
	LOADER: unknown;
	ROB: DurableObjectNamespace<ReorderBuffer>;
	ROUTER: DurableObjectNamespace<ArbRouter>;
	TRUNK: DurableObjectNamespace<ArbTrunk>;
	ASSETS?: Fetcher;
	POLL_FALLBACK?: string;
	POLL_INTERVAL_MS?: string;
	/** Admin key for destructive / token-minting endpoints (T19, review F1).
	 * Worker secret; checked in src/index.ts before any routing. */
	ARB_ADMIN_KEY?: string;
	/** (V2) TypeSafe API key for Jev semantic judgments. Optional Worker
	 * secret; absent = judgments report `jev.unavailable` (v1 behavior). */
	TYPESAFE_API_KEY?: string;
}

/** (V2) Per-entry declaration-source store for Jev `before`/`after` pairs,
 * kept in DO storage outside BufferState (the machine stays pure). */
function doSourceStore(ctx: DurableObjectState): SourceStorePort {
	const key = (entryId: string) => `src/${entryId}`;
	return {
		get: async (entryId) => (await ctx.storage.get<Record<string, SourceRecord>>(key(entryId))) ?? {},
		merge: async (entryId, map, commit, baselines) => {
			const k = key(entryId);
			const cur = (await ctx.storage.get<Record<string, SourceRecord>>(k)) ?? {};
			if (Object.keys(map).length) await ctx.storage.put(k, mergeSourceMap(cur, map, commit, baselines));
			else await ctx.storage.delete(k);
		},
		delete: async entryId => { await ctx.storage.delete(key(entryId)); },
		retain: async (entryId, symbols) => {
			const k = key(entryId);
			const current = (await ctx.storage.get<Record<string, SourceRecord>>(k)) ?? {};
			const kept = Object.fromEntries(symbols.filter(s => Object.hasOwn(current, s)).map(s => [s, current[s]]));
			if (symbols.length) await ctx.storage.put(k, kept);
			else await ctx.storage.delete(k);
		},
	};
}

/** The component DO's "retirer" is the shared ArbTrunk DO: every component
 * calls the same object, which serializes all trunk mutations (the trunk is
 * the single shared resource across shards). Retirement goes through the
 * atomic RPC (T17): build -> check -> move inside one queue slot. */
function stubRetirer(env: Env): TrunkRetirerPort {
	const stub = () => env.TRUNK.get(env.TRUNK.idFromName(TRUNK_NAME));
	return {
		retire: (args) => stub().retire(args),
		moveBranch: (args) => stub().moveBranch(args),
		retireAtomic: (args) => stub().retireAtomic(args),
	};
}

export class ReorderBuffer extends DurableObject<Env> {
	private ports: Ports;
	private state!: RobState;
	/** Per-repo write tokens (review F8): every authenticated
	 * GET /api/entries/:id gets one; minted tokens are reused for 30 min. */
	private tokens: TokenCache;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ports = {
			artifacts: realArtifacts(env.ARTIFACTS as Parameters<typeof realArtifacts>[0]),
			hasher: realHasher(),
			checker: realChecker({ ARTIFACTS: env.ARTIFACTS, LOADER: env.LOADER }),
			retirer: stubRetirer(env),
			sources: doSourceStore(ctx),
			jev: realJev(env.TYPESAFE_API_KEY),
		};
		this.tokens = tokenCache((repo) => this.ports.artifacts.token(repo, TOKEN_TTL_S));
		ctx.blockConcurrencyWhile(async () => {
			this.state = (await ctx.storage.get<RobState>(STATE_KEY)) ?? initialState();
			rebuildIndexes(this.state);
		});
	}

	// --- plumbing --------------------------------------------------------------

	private pollEnabled(): boolean {
		return (this.env.POLL_FALLBACK ?? "on").toLowerCase() !== "off";
	}

	private pollIntervalMs(): number {
		const n = Number(this.env.POLL_INTERVAL_MS ?? "3000");
		return Number.isFinite(n) && n >= 500 ? n : 3000;
	}

	private async persist(): Promise<void> {
		await this.ctx.storage.put(STATE_KEY, this.state);
		await this.ensureAlarm();
	}

	private hasPollTargets(): boolean {
		// Only live entries keep this component's alarm alive: a fully retired
		// or freshly reset component goes dormant (no zombie pollers — see
		// NOTES "DO version pinning"). The trunk repo is polled by ArbTrunk.
		return this.state.entries.some((e) => e.status !== "retired" && e.status !== "vetoed");
	}

	private async ensureAlarm(): Promise<void> {
		if (!this.pollEnabled()) return;
		const current = await this.ctx.storage.getAlarm();
		if (this.hasPollTargets()) {
			if (current === null) await this.ctx.storage.setAlarm(Date.now() + this.pollIntervalMs());
		} else if (current !== null) {
			await this.ctx.storage.deleteAlarm();
		}
	}

	private broadcast(ev: ArbEvent): void {
		const payload = JSON.stringify(ev);
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.send(payload);
			} catch {
				// socket died between getWebSockets and send; hibernation cleans up
			}
		}
		// Relay to the router DO, which fans the event into the shared /api/ws.
		this.ctx.waitUntil(this.emitToRouter(ev));
	}

	private async emitToRouter(ev: ArbEvent): Promise<void> {
		try {
			const stub = this.env.ROUTER.get(this.env.ROUTER.idFromName(ROUTER_NAME));
			await stub.fetch("https://router/internal/emit", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(ev),
			});
		} catch (e) {
			console.error("emit to router failed", errorText(e));
		}
	}

	/** Tell the router which component owns a repo so queue pushes route here. */
	private async registerRepo(repo: string): Promise<void> {
		try {
			const stub = this.env.ROUTER.get(this.env.ROUTER.idFromName(ROUTER_NAME));
			await stub.fetch("https://router/internal/registerRepo", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ repo, component: componentFromInstance(this.ctx.id.name ?? "") }),
			});
		} catch (e) {
			// Non-fatal: the alarm poll still detects pushes (at poll cadence).
			console.error("registerRepo failed", errorText(e));
		}
	}

	private applyCmd(cmd: Cmd): { ok: true; effects: Effect[] } | { ok: false; status: number; error: string } {
		const r = apply(this.state, cmd);
		if (!r.ok) return { ok: false, status: r.status, error: r.error };
		this.state = r.state;
		return { ok: true, effects: r.effects };
	}

	/** The effect runtime's view of this object (src/effects.ts). */
	private host(): EffectHost {
		return {
			ports: this.ports,
			state: () => this.state,
			apply: (cmd) => this.applyCmd(cmd),
			broadcast: (ev) => this.broadcast(ev),
			registerRepo: (repo) => this.ctx.waitUntil(this.registerRepo(repo)),
			tokens: this.tokens,
		};
	}

	/** Execute an effect list (and any follow-up effects) through the ports.
	 * Per-effect failure isolation lives in effects.ts (review F3). */
	private execEffects(initial: Effect[], out: EffectResults = { tokens: {} }): Promise<Effect[]> {
		return execEffects(this.host(), initial, out);
	}

	/** Shared push path for queue events and the alarm fallback. Hashing and
	 * the out-of-order guard (review F9) live in effects.ts. */
	private async processPush(repo: string, commit: string): Promise<void> {
		const cmd = await pushCommand(this.host(), repo, commit);
		if (!cmd) return;
		const r = this.applyCmd(cmd);
		if (r.ok) await this.execEffects(r.effects);
		await this.persist();
	}

	// --- RPC entry points -------------------------------------------------------

	/** Called by the queue consumer for each cf.artifacts.repo.pushed event. */
	async onPush(repo: string, commit: string): Promise<void> {
		await this.processPush(repo, commit);
	}

	/** Alarm fallback: poll this component's live entry repos (the trunk repo
	 * belongs to ArbTrunk, not this object). */
	async alarm(): Promise<void> {
		try {
			// Recovery sweep first (review F3): re-issue forks/checks/retires
			// whose in-flight markers outlived their deadline. Each recovery
			// emits a `recover` event.
			const sw = this.applyCmd({ type: "sweep" });
			if (sw.ok && sw.effects.length) {
				await this.execEffects(sw.effects);
				await this.persist();
			}
			const targets: Array<{ repo: string; known: string | null }> = [];
			for (const e of this.state.entries) {
				if (e.repo && !this.state._internal.pending[e.id] && e.status !== "retired" && e.status !== "vetoed") {
					targets.push({ repo: e.repo, known: e.headCommit });
				}
			}
			for (const t of targets) {
				const head = (await this.ports.artifacts.log(t.repo, 1))[0]?.hash ?? null;
				if (head && head !== t.known) await this.processPush(t.repo, head);
			}
		} finally {
			if (this.pollEnabled() && this.hasPollTargets()) {
				await this.ctx.storage.setAlarm(Date.now() + this.pollIntervalMs());
			}
		}
	}

	// --- HTTP API ---------------------------------------------------------------

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const { pathname } = url;

		if (pathname === "/api/ws") return this.handleWs();

		const json = (body: unknown, status = 200) =>
			new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

		try {
			// --- internal routes (ArbRouter fan-in / aggregation) -----------------
			if (request.method === "GET" && pathname === "/internal/state") {
				return json(publicState(this.state));
			}
			if (request.method === "GET" && pathname === "/internal/active") {
				return json({ active: this.state._internal.idx?.active ?? this.state.entries.filter((e) => e.status !== "retired").length });
			}
			if (request.method === "GET" && pathname === "/internal/events") {
				return json({ events: this.state._internal.eventLog });
			}
			if (request.method === "POST" && pathname === "/internal/reset") {
				const r = this.applyCmd({ type: "reset" });
				if (!r.ok) return json({ error: r.error }, r.status);
				await this.execEffects(r.effects);
				await this.persist();
				return json({ ok: true });
			}
			if (request.method === "POST" && pathname === "/internal/config") {
				const body = (await request.json()) as { robSize?: number };
				const r = this.applyCmd({ type: "config.set", robSize: body.robSize! });
				if (!r.ok) return json({ error: r.error }, r.status);
				await this.execEffects(r.effects);
				await this.persist();
				return json({ robSize: this.state.robSize });
			}
			if (request.method === "POST" && pathname === "/api/entries") {
				const body = (await request.json()) as {
					agent?: string;
					lane?: string;
					producerId?: string;
					consumes?: string[];
					stub?: Record<string, string>;
					/** Injected by ArbRouter: globally assigned identity + trunk
					 * bootstrap for a (possibly fresh) component DO. */
					id?: string;
					seq?: number;
					trunk?: { repo: string; remote: string; commit: string | null };
					robSize?: number;
				};
				if (!body.agent || !body.lane) return json({ error: "agent and lane are required" }, 400);
				// Component bootstrap: the router supplies trunk info + the global
				// robSize on every create; a fresh component learns them here.
				if (body.trunk && !this.state.trunk.repo) {
					const t = this.applyCmd({ type: "trunk.init", repo: body.trunk.repo, remote: body.trunk.remote, commit: body.trunk.commit });
					if (!t.ok) return json({ error: t.error }, t.status);
					await this.execEffects(t.effects);
				}
				if (body.robSize && body.robSize !== this.state.robSize) {
					const c = this.applyCmd({ type: "config.set", robSize: body.robSize });
					if (!c.ok) return json({ error: c.error }, c.status);
					await this.execEffects(c.effects);
				}
				// Declared-stub value prediction: hash the stub sources with the
				// real hasher so predicted hashes match what a real push would
				// produce (T11).
				let stub: { exports: ReturnType<typeof interfaceToMaps>["exports"]; sigs: ReturnType<typeof interfaceToMaps>["sigs"] } | undefined;
				if (body.stub && typeof body.stub === "object" && Object.keys(body.stub).length > 0) {
					stub = interfaceToMaps(await this.ports.hasher.hashInterface(body.stub));
				}
				const r = this.applyCmd({
					type: "entry.create",
					agent: body.agent,
					lane: body.lane,
					producerId: body.producerId,
					consumes: body.consumes,
					stub,
					id: body.id,
					seq: body.seq,
				});
				if (!r.ok) return json({ error: r.error }, r.status);
				const createdEv = r.effects.find(
					(e): e is Extract<Effect, { type: "broadcast" }> => e.type === "broadcast" && e.event.type === "entry.created",
				);
				const out: EffectResults = { tokens: {} };
				await this.execEffects(r.effects, out);
				const entry = this.state.entries.find((e) => e.id === createdEv?.event.entryId)!;
				await this.persist();
				return json({ entry, token: out.tokens[entry.id] ?? null });
			}
			const mEntry = pathname.match(/^\/api\/entries\/(e\d+)(\/ready|\/veto)?$/);
			if (mEntry) {
				const id = mEntry[1];
				const entry = this.state.entries.find((e) => e.id === id);
				if (!entry) return json({ error: `entry ${id} not found` }, 404);
				if (request.method === "GET" && !mEntry[2]) {
					// The Worker only lets admin-key requests reach this route
					// (src/auth.ts), so every caller is authorized: hand each one
					// a write token for the CURRENT repo (review F8). While a
					// re-fork is in flight the entry has no usable repo yet, so
					// the token is withheld until the fork lands.
					if (!entry.repo || this.state._internal.pending[id]) return json({ entry });
					const token = await this.tokens.get(entry.repo);
					return json({ entry, token });
				}
				if (request.method === "POST" && mEntry[2] === "/ready") {
					const body = (await request.json()) as { commit?: string };
					if (!body.commit) return json({ error: "commit is required" }, 400);
					const r = this.applyCmd({ type: "entry.ready", entryId: id, commit: body.commit });
					if (!r.ok) return json({ error: r.error }, r.status);
					await this.execEffects(r.effects);
					await this.persist();
					return json({ entry });
				}
				if (request.method === "POST" && mEntry[2] === "/veto") {
					const r = this.applyCmd({ type: "entry.veto", entryId: id });
					if (!r.ok) return json({ error: r.error }, r.status);
					const squashed = r.effects
						.filter((e): e is Extract<Effect, { type: "broadcast" }> => e.type === "broadcast" && e.event.type === "squash")
						.map((e) => e.event.entryId!);
					await this.execEffects(r.effects);
					await this.persist();
					return json({ entry, squashed });
				}
				return json({ error: "method not allowed" }, 405);
			}
			return json({ error: "not found" }, 404);
		} catch (e) {
			return json({ error: errorText(e) }, 500);
		}
	}

	private handleWs(): Response {
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		this.ctx.acceptWebSocket(server);
		server.send(JSON.stringify({ type: "snapshot", ts: Date.now(), data: publicState(this.state) }));
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
		// Clients send nothing (contract).
	}

	async webSocketClose(_ws: WebSocket): Promise<void> {}

	async webSocketError(_ws: WebSocket, error: unknown): Promise<void> {
		console.error("ws error", error);
	}
}
