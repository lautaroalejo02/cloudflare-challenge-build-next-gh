const now = () => Date.now();

async function timeCall(fn) {
	const t0 = now();
	try {
		const value = await fn();
		return { ok: true, ms: now() - t0, value };
	} catch (e) {
		return { ok: false, ms: now() - t0, error: String(e && e.message ? e.message : e), name: e && e.name, code: e && e.code };
	}
}

async function forkTimed(artifacts, src, dst, opts) {
	const g = await timeCall(() => artifacts.get(src));
	if (!g.ok) return { ok: false, stage: "get", getMs: g.ms, error: g.error, name: g.name, code: g.code };
	const f = await timeCall(() => g.value.fork(dst, opts));
	return { ok: f.ok, stage: "fork", getMs: g.ms, forkMs: f.ms, error: f.error, name: f.name, code: f.code, result: f.ok ? { name: f.value.name, remote: f.value.remote, defaultBranch: f.value.defaultBranch, token: f.value.token } : undefined };
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
		const A = env.ARTIFACTS;

		if (url.pathname === "/create") {
			const r = await timeCall(() => A.create(body.name, body.opts || {}));
			if (!r.ok) return Response.json(r, { status: 500 });
			const v = r.value;
			return Response.json({ ms: r.ms, name: v.name, remote: v.remote, defaultBranch: v.defaultBranch, token: v.token });
		}

		if (url.pathname === "/fork") {
			return Response.json(await forkTimed(A, body.src, body.dst, body.opts || {}));
		}

		if (url.pathname === "/info") {
			const r = await timeCall(async () => {
				const repo = await A.get(body.name);
				return await repo.info();
			});
			return Response.json(r, { status: r.ok ? 200 : 500 });
		}

		if (url.pathname === "/log") {
			const r = await timeCall(async () => {
				const repo = await A.get(body.name);
				return await repo.log({ ref: body.ref, limit: body.limit || 10 });
			});
			return Response.json(r, { status: r.ok ? 200 : 500 });
		}

		if (url.pathname === "/token") {
			const r = await timeCall(async () => {
				const repo = await A.get(body.name);
				return await repo.createToken(body.scope || "write", body.ttl || 3600);
			});
			return Response.json(r, { status: r.ok ? 200 : 500 });
		}

		if (url.pathname === "/burst") {
			// body: {src, prefix, count, mode: "seq"|"par", opts}
			const results = [];
			const one = (i) => forkTimed(A, body.src, `${body.prefix}-${i}`, body.opts || {});
			const wall0 = now();
			if (body.mode === "par") {
				const rs = await Promise.all(Array.from({ length: body.count }, (_, i) => one(i)));
				results.push(...rs);
			} else {
				for (let i = 0; i < body.count; i++) results.push(await one(i));
			}
			return Response.json({ wallMs: now() - wall0, results });
		}

		return new Response("routes: /create /fork /info /log /token /burst", { status: 404 });
	},
};
