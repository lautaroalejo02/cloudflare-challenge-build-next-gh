// arb-control-plane Worker (T14, sharded):
//   POST /api/trunk/init           -> ArbTrunk DO (+ router gets trunk info)
//   /api/* (everything else)       -> ArbRouter DO (routes to component DOs,
//                                   aggregates state/events/ws)
//   queue consumer (repo.pushed)   -> router routes by repo name: trunk ->
//                                   ArbTrunk.onPush, fork repo -> the owning
//                                   component DO's onPush
//   everything else                -> static assets (app/dashboard)
//
// Durable Object layout:
//   ArbRouter   "router-t14"   routing table, ws hub, create orchestration
//   ArbTrunk    "trunk-t14"    serialized retirement onto arb-trunk
//   ReorderBuffer "comp-e<n>"  one per connected producer/consumer component

import { ReorderBuffer, type Env } from "./do.ts";
import { ArbRouter, ROUTER_NAME } from "./router.ts";
import { ArbTrunk, TRUNK_NAME } from "./trunk.ts";

export { ReorderBuffer, ArbRouter, ArbTrunk };

interface RepoPushedEvent {
	type?: string;
	source?: { namespace?: string; repoName?: string; type?: string };
	payload?: { ref?: string; before?: string; after?: string };
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/api/trunk/init" && request.method === "POST") {
			const trunk = env.TRUNK.get(env.TRUNK.idFromName(TRUNK_NAME));
			const resp = await trunk.fetch(request);
			if (resp.ok) {
				// Give the router the trunk info it injects into component creates.
				const body = (await resp.clone().json()) as { repo: string; remote: string };
				const router = env.ROUTER.get(env.ROUTER.idFromName(ROUTER_NAME));
				const tr = await trunk.getTrunk();
				await router.fetch("https://router/internal/trunk", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ repo: body.repo, remote: body.remote, commit: tr.commit }),
				});
			}
			return resp;
		}
		if (url.pathname.startsWith("/api/")) {
			const router = env.ROUTER.get(env.ROUTER.idFromName(ROUTER_NAME));
			return router.fetch(request);
		}
		if (env.ASSETS) return env.ASSETS.fetch(request);
		return new Response("not found", { status: 404 });
	},

	async queue(batch, env): Promise<void> {
		const router = env.ROUTER.get(env.ROUTER.idFromName(ROUTER_NAME));
		for (const msg of batch.messages) {
			try {
				const ev = msg.body as RepoPushedEvent;
				const after = ev?.payload?.after;
				if (
					ev?.type === "cf.artifacts.repo.pushed" &&
					ev?.source?.namespace === "arb" &&
					ev?.payload?.ref === "refs/heads/main" &&
					after &&
					!/^0+$/.test(after)
				) {
					const repo = ev.source.repoName!;
					const r = await router.fetch(
						`https://router/internal/routeRepo?repo=${encodeURIComponent(repo)}`,
					);
					const route = (await r.json()) as { target: "trunk" | "component" | null; component?: string };
					if (route.target === "trunk") {
						const trunk = env.TRUNK.get(env.TRUNK.idFromName(TRUNK_NAME));
						await trunk.onPush(repo, after);
					} else if (route.target === "component" && route.component) {
						const comp = env.ROB.get(env.ROB.idFromName(route.component));
						await comp.onPush(repo, after);
					}
					// null route: unknown/stale repo (e.g. leftover from a reset) — drop.
				}
				msg.ack();
			} catch (e) {
				console.error("queue message failed", e);
				msg.retry();
			}
		}
	},
} satisfies ExportedHandler<Env>;
