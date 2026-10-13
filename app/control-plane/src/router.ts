// ArbRouter Durable Object (T14): the routing table and fan-in point for the
// sharded control plane.
//
//   - Owns the global seq counter (entries keep contract ids `e<seq>`).
//   - Maps entryId -> component DO name and repo name -> component DO name,
//     so `/api/entries/:id` and queue push events reach the right shard.
//   - Orchestrates POST /api/entries: enforces the GLOBAL robSize (a
//     per-component check would change contract semantics), assigns id/seq,
//     picks the component (producer's component, or `comp-<id>` for roots),
//     and forwards the create to that component DO with the assigned identity.
//   - Aggregates GET /api/state and GET /api/events across components, and
//     serves GET /api/ws: clients connect here, receive one aggregated
//     snapshot, then live events that component DOs push to /internal/emit.
//   - Fans /api/config and /api/reset out to every component.
//
// The router is also a single DO, so its fetch handlers serialize the
// admission sequence (count -> assign -> forward) without races.

import { DurableObject } from "cloudflare:workers";
import type { ArbEvent, BufferState } from "./rob.ts";
import {
	componentInstance,
	componentName,
	emptyRouterState,
	mergeEvents,
	mergeStates,
	repoToEntryId,
	resetRouterState,
	type RouterState,
} from "./shard.ts";
import { errorText } from "../../checker/src/retry.ts";
import type { ArbTrunk, TrunkInfo } from "./trunk.ts";
import type { ReorderBuffer } from "./do.ts";
import type { Env } from "./do.ts";
import { TRUNK_NAME } from "./trunk.ts";

// Name bump at T19 (review F10): fresh instance on the new code, and a
// fresh routing table whose seq continues across resets from here on.
export const ROUTER_NAME = "router-t19";
const STATE_KEY = "router";
const TRUNK_REPO = "arb-trunk";

export class ArbRouter extends DurableObject<Env> {
	private st: RouterState = emptyRouterState();
	/** Serializes POST /api/entries end to end (review F11): the handler awaits
	 * component fetches, and DO handlers interleave on await, so two creates
	 * could both pass the robSize count without this. */
	private createQueue: Promise<unknown> = Promise.resolve();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			this.st = (await ctx.storage.get<RouterState>(STATE_KEY)) ?? this.st;
			this.st = { ...emptyRouterState(), ...this.st };
		});
	}

	private persist(): Promise<void> {
		return this.ctx.storage.put(STATE_KEY, this.st);
	}

	private comp(name: string): DurableObjectStub<ReorderBuffer> {
		return this.env.ROB.get(this.env.ROB.idFromName(componentInstance(name)));
	}

	private trunk(): DurableObjectStub<ArbTrunk> {
		return this.env.TRUNK.get(this.env.TRUNK.idFromName(TRUNK_NAME));
	}

	/** Route a push event's repo name: "trunk", a component DO name, or null
	 * (unknown/stale repo — the event is dropped). */
	async routeRepo(repo: string): Promise<{ target: "trunk" | "component" | null; component?: string }> {
		if (repo === (this.st.trunk?.repo ?? TRUNK_REPO) || repo === TRUNK_REPO) return { target: "trunk" };
		const component = this.st.repoComp[repo] ?? this.st.entryComp[repoToEntryId(repo) ?? ""] ?? null;
		return { target: component ? "component" : null, component: component ?? undefined };
	}

	/** Component DOs push every broadcast ArbEvent here; the router relays it
	 * to connected dashboard WebSockets (the fan-in half of /api/ws). */
	emit(ev: ArbEvent): void {
		this.broadcast(ev);
	}

	private broadcast(ev: ArbEvent): void {
		const payload = JSON.stringify(ev);
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.send(payload);
			} catch {
				// dead socket; hibernation cleanup handles it
			}
		}
	}

	private async aggregatedState(): Promise<BufferState> {
		const parts = await Promise.all(
			this.st.components.map(async (name) => {
				const r = await this.comp(name).fetch("https://comp/internal/state");
				return (await r.json()) as BufferState;
			}),
		);
		const trunk = await this.trunk().getTrunk();
		const merged = mergeStates(parts, { repo: trunk.repo || this.st.trunk?.repo || TRUNK_REPO, commit: trunk.commit }, this.st.robSize);
		for (const e of merged.entries) (e as unknown as { component?: string }).component = this.st.entryComp[e.id];
		return merged;
	}

	// --- entry create orchestration --------------------------------------------

	private async createEntry(body: {
		agent?: string;
		lane?: string;
		producerId?: string;
		consumes?: string[];
		stub?: Record<string, string>;
	}): Promise<Response> {
		const json = (b: unknown, status = 200) =>
			new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
		if (!body.agent || !body.lane) return json({ error: "agent and lane are required" }, 400);
		if (!this.st.trunk) return json({ error: "trunk not initialized" }, 409);
		let component: string;
		let isNew = false;
		if (body.producerId) {
			const c = this.st.entryComp[body.producerId];
			if (!c) return json({ error: `producer ${body.producerId} not found` }, 404);
			component = c;
		} else {
			isNew = true;
		}
		// Global capacity: sum each component's non-retired count. The router
		// serializes creates, so the count-then-assign sequence cannot race.
		let active = 0;
		for (const name of this.st.components) {
			const r = await this.comp(name).fetch("https://comp/internal/active");
			active += ((await r.json()) as { active: number }).active;
		}
		if (active >= this.st.robSize) return json({ error: "reorder buffer full" }, 409);
		const seq = this.st.nextSeq + 1;
		const id = `e${seq}`;
		if (isNew) component = componentName(id);
		this.st.nextSeq = seq;
		this.st.entryComp[id] = component!;
		if (!this.st.components.includes(component!)) this.st.components.push(component!);
		await this.persist();
		const resp = await this.comp(component!).fetch("https://comp/api/entries", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ...body, id, seq, trunk: this.st.trunk, robSize: this.st.robSize }),
		});
		if (!resp.ok) {
			// Roll the reservation back (burned seq is fine — gaps are legal).
			delete this.st.entryComp[id];
			if (isNew) this.st.components = this.st.components.filter((c) => c !== component);
			await this.persist();
		}
		return resp;
	}

	// --- HTTP API ---------------------------------------------------------------

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const { pathname } = url;
		const json = (body: unknown, status = 200) =>
			new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

		if (pathname === "/api/ws") return this.handleWs();

		try {
			// Component DO -> router event relay (WS fan-in).
			if (request.method === "POST" && pathname === "/internal/emit") {
				this.broadcast((await request.json()) as ArbEvent);
				return json({ ok: true });
			}
			if (request.method === "POST" && pathname === "/internal/registerRepo") {
				const b = (await request.json()) as { repo?: string; component?: string };
				if (b.repo && b.component) {
					this.st.repoComp[b.repo] = b.component;
					await this.persist();
				}
				return json({ ok: true });
			}
			if (request.method === "GET" && pathname === "/internal/routeRepo") {
				return json(await this.routeRepo(url.searchParams.get("repo") ?? ""));
			}
			// Worker -> router after /api/trunk/init so creates can bootstrap
			// component trunk state.
			if (request.method === "POST" && pathname === "/internal/trunk") {
				this.st.trunk = (await request.json()) as TrunkInfo;
				await this.persist();
				return json({ ok: true });
			}
			if (request.method === "POST" && pathname === "/api/entries") {
				const body = (await request.json()) as Parameters<ArbRouter["createEntry"]>[0];
				const p = this.createQueue.then(() => this.createEntry(body));
				this.createQueue = p.catch(() => undefined);
				return await p;
			}
			const mEntry = pathname.match(/^\/api\/entries\/(e\d+)(\/ready|\/veto)?$/);
			if (mEntry) {
				const component = this.st.entryComp[mEntry[1]];
				if (!component) return json({ error: `entry ${mEntry[1]} not found` }, 404);
				return this.comp(component).fetch(request);
			}
			if (request.method === "POST" && pathname === "/api/config") {
				const body = (await request.json()) as { robSize?: number };
				if (!Number.isInteger(body.robSize) || (body.robSize ?? 0) < 1) return json({ error: "robSize must be a positive integer" }, 400);
				const robSize = body.robSize!;
				this.st.robSize = robSize;
				await this.persist();
				await Promise.all(
					this.st.components.map((name) =>
						this.comp(name).fetch("https://comp/internal/config", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ robSize }),
						}),
					),
				);
				return json({ robSize });
			}
			if (request.method === "GET" && pathname === "/api/state") {
				return json(await this.aggregatedState());
			}
			if (request.method === "GET" && pathname === "/api/events") {
				const logs = await Promise.all(
					this.st.components.map(async (name) => {
						const r = await this.comp(name).fetch("https://comp/internal/events");
						return ((await r.json()) as { events: ArbEvent[] }).events;
					}),
				);
				return json({ events: mergeEvents(logs) });
			}
			if (request.method === "POST" && pathname === "/api/reset") {
				await Promise.all(
					this.st.components.map((name) =>
						this.comp(name).fetch("https://comp/internal/reset", { method: "POST" }),
					),
				);
				await this.trunk().fetch("https://trunk/internal/reset", { method: "POST" });
				this.st = resetRouterState(this.st);
				await this.persist();
				this.broadcast({ type: "reset", ts: Date.now() });
				return json({ ok: true });
			}
			return json({ error: "not found" }, 404);
		} catch (e) {
			return json({ error: errorText(e) }, 500);
		}
	}

	private async handleWs(): Promise<Response> {
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		this.ctx.acceptWebSocket(server);
		let snapshot: BufferState;
		try {
			snapshot = await this.aggregatedState();
		} catch {
			snapshot = mergeStates([], { repo: this.st.trunk?.repo ?? TRUNK_REPO, commit: this.st.trunk?.commit ?? null }, this.st.robSize);
		}
		server.send(JSON.stringify({ type: "snapshot", ts: Date.now(), data: snapshot }));
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {}

	async webSocketClose(_ws: WebSocket): Promise<void> {}

	async webSocketError(_ws: WebSocket, error: unknown): Promise<void> {
		console.error("router ws error", error);
	}
}
