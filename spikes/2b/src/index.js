const REPO = "spike-2b-repo";
const POLL_MS = 2000;

function hashOf(c) {
	return c.hash || c.sha || c.oid || c.id || JSON.stringify(c);
}

async function dispose(repo) {
	if (!repo) return;
	if (typeof repo[Symbol.dispose] === "function") repo[Symbol.dispose]();
	else if (typeof repo.dispose === "function") repo.dispose();
}

export class Spike2bPoller {
	constructor(ctx, env) {
		this.ctx = ctx;
		this.env = env;
	}

	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/start") {
			const head = await this.head();
			await this.ctx.storage.put({
				lastHash: head ? head.hash : null,
				alarms: 0,
				logCalls: 0,
				logErrors: 0,
				wallMs: [],
				detections: [],
				errMsgs: [],
				startedAt: Date.now(),
			});
			await this.ctx.storage.setAlarm(Date.now() + POLL_MS);
			return Response.json({ started: true, initialHead: head });
		}
		if (url.pathname === "/stop") {
			await this.ctx.storage.deleteAlarm();
			return Response.json({ stopped: true, at: Date.now() });
		}
		if (url.pathname === "/state") {
			const keys = ["lastHash", "alarms", "logCalls", "logErrors", "wallMs", "detections", "errMsgs", "startedAt"];
			const out = {};
			for (const k of keys) out[k] = await this.ctx.storage.get(k);
			out.now = Date.now();
			return Response.json(out);
		}
		return new Response("poller alive");
	}

	async head() {
		const repo = await this.env.ARTIFACTS.get(REPO);
		try {
			const h = await repo.log({ limit: 1 });
			return h && h.length ? { hash: hashOf(h[0]), commit: h[0] } : null;
		} finally {
			await dispose(repo);
		}
	}

	async alarm() {
		await this.ctx.storage.put("alarms", ((await this.ctx.storage.get("alarms")) || 0) + 1);
		try {
			const repo = await this.env.ARTIFACTS.get(REPO);
			const t0 = Date.now();
			let h;
			try {
				h = await repo.log({ limit: 1 });
			} finally {
				await dispose(repo);
			}
			const wall = Date.now() - t0;
			const wallMs = (await this.ctx.storage.get("wallMs")) || [];
			wallMs.push(wall);
			await this.ctx.storage.put({
				logCalls: ((await this.ctx.storage.get("logCalls")) || 0) + 1,
				wallMs,
			});
			const head = h && h.length ? h[0] : null;
			const headHash = head ? hashOf(head) : null;
			const last = await this.ctx.storage.get("lastHash");
			if (head && headHash !== last) {
				const detections = (await this.ctx.storage.get("detections")) || [];
				detections.push({ commit: head, detectedAt: Date.now() });
				await this.ctx.storage.put({ lastHash: headHash, detections });
			}
		} catch (e) {
			const errMsgs = (await this.ctx.storage.get("errMsgs")) || [];
			errMsgs.push(String(e && e.message ? e.message : e).slice(0, 300));
			await this.ctx.storage.put({
				logErrors: ((await this.ctx.storage.get("logErrors")) || 0) + 1,
				errMsgs,
			});
		} finally {
			await this.ctx.storage.setAlarm(Date.now() + POLL_MS);
		}
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (request.method === "POST" && url.pathname === "/setup") {
			const created = await env.ARTIFACTS.create(REPO, { setDefaultBranch: "main" });
			return Response.json({ name: created.name, remote: created.remote, token: created.token, defaultBranch: created.defaultBranch });
		}
		if (url.pathname === "/repo-token") {
			const repo = await env.ARTIFACTS.get(REPO);
			try {
				const t = await repo.createToken("write", 3600);
				return Response.json(t);
			} finally {
				await dispose(repo);
			}
		}
		const stub = env.POLLER.get(env.POLLER.idFromName("main"));
		return stub.fetch(request);
	},
};
