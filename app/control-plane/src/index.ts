// arb-control-plane Worker: /api/* -> ReorderBuffer DO, queue consumer ->
// DO.onPush, everything else -> static assets (app/dashboard).

import { ReorderBuffer, type Env } from "./do.ts";

export { ReorderBuffer };

interface RepoPushedEvent {
	type?: string;
	source?: { namespace?: string; repoName?: string; type?: string };
	payload?: { ref?: string; before?: string; after?: string };
}

// DO id: bump to spawn a fresh object on new code. The previous object keeps
// running on the old version while its alarm stays warm (read-only repo polls).
const DO_NAME = "default-t8g";

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname.startsWith("/api/")) {
			const stub = env.ROB.get(env.ROB.idFromName(DO_NAME));
			return stub.fetch(request);
		}
		if (env.ASSETS) return env.ASSETS.fetch(request);
		return new Response("not found", { status: 404 });
	},

	async queue(batch, env): Promise<void> {
		const stub = env.ROB.get(env.ROB.idFromName(DO_NAME));
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
					await stub.onPush(ev.source.repoName!, after);
				}
				msg.ack();
			} catch (e) {
				console.error("queue message failed", e);
				msg.retry();
			}
		}
	},
} satisfies ExportedHandler<Env>;
