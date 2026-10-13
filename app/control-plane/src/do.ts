// ReorderBuffer Durable Object: one instance ("default") owns the whole
// buffer. It feeds commands into the pure machine (src/rob.ts), persists the
// returned state, executes effects through ports (src/ports.ts), and
// broadcasts ArbEvents to dashboard WebSockets (hibernation API).

import { DurableObject } from "cloudflare:workers";
import {
	apply,
	initialState,
	publicState,
	type ArbEvent,
	type Cmd,
	type Effect,
	type RobState,
} from "./rob.ts";
import {
	interfaceToMaps,
	realArtifacts,
	realChecker,
	realHasher,
	type ArtifactsPort,
	type Ports,
} from "./ports.ts";
import { realRetirer, type ArtifactsBinding } from "./retire.ts";

function isAlreadyExists(e: unknown): boolean {
	const code = (e as { code?: string })?.code;
	const msg = String((e as Error)?.message ?? e);
	return code === "ALREADY_EXISTS" || /ALREADY_EXISTS|already exists/i.test(msg);
}

const TRUNK_REPO = "arb-trunk";
const STATE_KEY = "state";
const SEEN_REPO_KEY = "seenRepo";
const TOKEN_TTL_S = 3600;

export interface Env {
	ARTIFACTS: unknown;
	LOADER: unknown;
	ROB: DurableObjectNamespace<ReorderBuffer>;
	ASSETS?: Fetcher;
	POLL_FALLBACK?: string;
	POLL_INTERVAL_MS?: string;
}

interface EffectResults {
	tokens: Record<string, string>;
}

export class ReorderBuffer extends DurableObject<Env> {
	private ports: Ports;
	private state!: RobState;
	/** entryId -> repo the last minted token was scoped to. A fresh token is
	 * handed out whenever the repo changes (create, re-fork): Artifacts tokens
	 * are per-repo, so keying on generation instead would mint stale-repo
	 * tokens in the squash->refork gap. */
	private seenRepo: Record<string, string> = {};

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ports = {
			artifacts: realArtifacts(env.ARTIFACTS as Parameters<typeof realArtifacts>[0]),
			hasher: realHasher(),
			checker: realChecker({ ARTIFACTS: env.ARTIFACTS, LOADER: env.LOADER }),
			retirer: realRetirer(env.ARTIFACTS as ArtifactsBinding),
		};
		ctx.blockConcurrencyWhile(async () => {
			this.state = (await ctx.storage.get<RobState>(STATE_KEY)) ?? initialState();
			// Forward-fill internal fields added after the state was persisted.
			this.state._internal = { ...initialState()._internal, ...(this.state._internal ?? {}) };
			this.seenRepo = (await ctx.storage.get<Record<string, string>>(SEEN_REPO_KEY)) ?? {};
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
		await this.ctx.storage.put(SEEN_REPO_KEY, this.seenRepo);
		await this.ensureAlarm();
	}

	private hasPollTargets(): boolean {
		if (!this.state.trunk.repo) return false;
		return true; // trunk alone is worth polling for its first commit
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
	}

	private applyCmd(cmd: Cmd): { ok: true; effects: Effect[] } | { ok: false; status: number; error: string } {
		const r = apply(this.state, cmd);
		if (!r.ok) return { ok: false, status: r.status, error: r.error };
		this.state = r.state;
		return { ok: true, effects: r.effects };
	}

	/** Execute an effect list (and any follow-up effects) through the ports. */
	private async execEffects(initial: Effect[], out: EffectResults = { tokens: {} }): Promise<Effect[]> {
		const all: Effect[] = [];
		const queue = [...initial];
		while (queue.length) {
			const eff = queue.shift()!;
			all.push(eff);
			switch (eff.type) {
				case "broadcast":
					this.broadcast(eff.event);
					break;
				case "token": {
					out.tokens[eff.entryId] = await this.ports.artifacts.token(eff.repo, TOKEN_TTL_S);
					break;
				}
				case "fork": {
					// A transitive refork may target a planned name that later got a
					// suffix; resolve to the actual repo. Repos left over from
					// before a reset make planned names collide — suffix until
					// free (reset does not delete repos; contract naming gap).
					const fromRepo = this.state._internal.repoAlias?.[eff.fromRepo] ?? eff.fromRepo;
					let created: Awaited<ReturnType<ArtifactsPort["fork"]>> | null = null;
					let toRepo = eff.toRepo;
					for (let attempt = 0; attempt < 30 && !created; attempt++) {
						try {
							created = await this.ports.artifacts.fork(fromRepo, toRepo);
						} catch (e) {
							if (isAlreadyExists(e)) {
								// Repos accumulate across runs (reset doesn't delete
								// them): after the deterministic -xN space, fall back
								// to random suffixes.
								toRepo =
									attempt < 19
										? `${eff.toRepo}-x${attempt + 1}`
										: `${eff.toRepo}-${Math.random().toString(36).slice(2, 8)}`;
							} else if (attempt < 1) {
								continue; // one retry for transient platform errors
							} else {
								throw e;
							}
						}
					}
					if (!created) throw new Error(`fork ${eff.toRepo} failed after retries`);
					const head = (await this.ports.artifacts.log(created.name, 1))[0]?.hash ?? "";
					const files = head ? await this.ports.artifacts.readTree(created.name, head) : {};
					const ih = await this.ports.hasher.hashInterface(files);
					const { exports, sigs } = interfaceToMaps(ih);
					const r = this.applyCmd({
						type: "fork.done",
						entryId: eff.entryId,
						repo: created.name,
						remote: created.remote,
						baseCommit: head,
						exports,
						sigs,
					});
					if (r.ok) queue.push(...r.effects);
					break;
				}
				case "check": {
					const result = await this.ports.checker.runChecks(eff.repo, eff.commit);
					const r = this.applyCmd({ type: "check.done", entryId: eff.entryId, result });
					if (r.ok) queue.push(...r.effects);
					break;
				}
				case "retire": {
					const res = await this.ports.retirer.retire({
						fromRepo: eff.fromRepo,
						commit: eff.commit,
						baseCommit: eff.baseCommit,
						toRepo: eff.toRepo,
						branch: eff.branch,
					});
					let r;
					if (res.outcome === "fast-forward") {
						r = this.applyCmd({
							type: "retire.done",
							entryId: eff.entryId,
							commit: res.commit,
							entryCommit: eff.commit,
							mode: "fast-forward",
						});
					} else if (res.outcome === "splice") {
						r = this.applyCmd({ type: "retire.planned", entryId: eff.entryId, candidate: res.candidate });
					} else {
						r = this.applyCmd({ type: "retire.overlap", entryId: eff.entryId, overlap: res.overlap });
					}
					if (r.ok) queue.push(...r.effects);
					break;
				}
				case "retire.commit": {
					// The splice candidate passed its checks: land it on trunk.
					await this.ports.retirer.moveBranch({
						toRepo: eff.toRepo,
						branch: eff.branch,
						commit: eff.candidate,
					});
					const r = this.applyCmd({
						type: "retire.done",
						entryId: eff.entryId,
						commit: eff.candidate,
						mode: "splice",
					});
					if (r.ok) queue.push(...r.effects);
					break;
				}
			}
		}
		return all;
	}

	/** Hash the .ts surface of a repo at a commit. */
	private async interfaceAt(repo: string, commit: string) {
		const files = await this.ports.artifacts.readTree(repo, commit);
		return interfaceToMaps(await this.ports.hasher.hashInterface(files));
	}

	/** Shared push path for queue events and the alarm fallback. */
	private async processPush(repo: string, commit: string): Promise<void> {
		const st = this.state;
		if (st._internal.seenPushes.includes(`${repo}:${commit}`)) return;
		let cmd: Cmd;
		if (repo === st.trunk.repo) {
			if (st.trunk.commit === commit) return;
			cmd = { type: "push", repo, commit };
		} else {
			const entry = st.entries.find(
				(e) => e.repo === repo || st._internal.pending[e.id] === repo,
			);
			if (!entry || entry.headCommit === commit) return;
			const { exports, sigs } = await this.interfaceAt(repo, commit);
			cmd = { type: "push", repo, commit, exports, sigs };
		}
		const r = this.applyCmd(cmd);
		if (r.ok) await this.execEffects(r.effects);
		await this.persist();
	}

	// --- RPC entry points -------------------------------------------------------

	/** Called by the queue consumer for each cf.artifacts.repo.pushed event. */
	async onPush(repo: string, commit: string): Promise<void> {
		await this.processPush(repo, commit);
	}

	/** Alarm fallback: poll active repos' heads (spike 2b pattern). */
	async alarm(): Promise<void> {
		try {
			const targets: Array<{ repo: string; known: string | null }> = [];
			if (this.state.trunk.repo) targets.push({ repo: this.state.trunk.repo, known: this.state.trunk.commit });
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
			if (request.method === "POST" && pathname === "/api/trunk/init") {
				return json(await this.trunkInit());
			}
			if (request.method === "POST" && pathname === "/api/entries") {
				const body = (await request.json()) as {
					agent?: string;
					lane?: string;
					producerId?: string;
					consumes?: string[];
					stub?: Record<string, string>;
				};
				if (!body.agent || !body.lane) return json({ error: "agent and lane are required" }, 400);
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
				});
				if (!r.ok) return json({ error: r.error }, r.status);
				const createdEv = r.effects.find(
					(e): e is Extract<Effect, { type: "broadcast" }> => e.type === "broadcast" && e.event.type === "entry.created",
				);
				const out: EffectResults = { tokens: {} };
				await this.execEffects(r.effects, out);
				const entry = this.state.entries.find((e) => e.id === createdEv?.event.entryId)!;
				this.seenRepo[entry.id] = entry.repo;
				await this.persist();
				return json({ entry, token: out.tokens[entry.id] ?? null });
			}
			const mEntry = pathname.match(/^\/api\/entries\/(e\d+)(\/ready|\/veto)?$/);
			if (mEntry) {
				const id = mEntry[1];
				const entry = this.state.entries.find((e) => e.id === id);
				if (!entry) return json({ error: `entry ${id} not found` }, 404);
				if (request.method === "GET" && !mEntry[2]) {
					let token: string | undefined;
					if (entry.repo && entry.repo !== this.seenRepo[id]) {
						token = await this.ports.artifacts.token(entry.repo, TOKEN_TTL_S);
						this.seenRepo[id] = entry.repo;
						await this.persist();
					}
					return json(token ? { entry, token } : { entry });
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
			if (request.method === "POST" && pathname === "/api/config") {
				const body = (await request.json()) as { robSize?: number };
				if (body.robSize === undefined) return json({ error: "robSize is required" }, 400);
				const r = this.applyCmd({ type: "config.set", robSize: body.robSize });
				if (!r.ok) return json({ error: r.error }, r.status);
				await this.execEffects(r.effects);
				await this.persist();
				return json({ robSize: this.state.robSize });
			}
			if (request.method === "GET" && pathname === "/api/state") {
				return json(publicState(this.state));
			}
			if (request.method === "GET" && pathname === "/api/events") {
				// Debug/measurement aid (not in the contract): the internal
				// ArbEvent log with server timestamps.
				return json({ events: this.state._internal.eventLog });
			}
			if (request.method === "POST" && pathname === "/api/reset") {
				const r = this.applyCmd({ type: "reset" });
				if (!r.ok) return json({ error: r.error }, r.status);
				this.seenRepo = {};
				await this.execEffects(r.effects);
				await this.persist();
				return json({ ok: true });
			}
			return json({ error: "not found" }, 404);
		} catch (e) {
			return json({ error: String(e instanceof Error ? e.message : e) }, 500);
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

	// --- trunk init -------------------------------------------------------------

	private async trunkInit(): Promise<{ repo: string; remote: string; token: string }> {
		let remote: string;
		let commit: string | null = null;
		try {
			remote = await this.ports.artifacts.getRemote(TRUNK_REPO);
			commit = (await this.ports.artifacts.log(TRUNK_REPO, 1))[0]?.hash ?? null;
		} catch {
			const created = await this.ports.artifacts.create(TRUNK_REPO, {
				setDefaultBranch: "main",
				description: "ARB trunk",
			});
			remote = created.remote;
		}
		const r = this.applyCmd({ type: "trunk.init", repo: TRUNK_REPO, remote, commit });
		if (!r.ok) throw new Error(r.error);
		await this.execEffects(r.effects);
		const token = await this.ports.artifacts.token(TRUNK_REPO, TOKEN_TTL_S);
		await this.persist();
		return { repo: TRUNK_REPO, remote, token };
	}
}
