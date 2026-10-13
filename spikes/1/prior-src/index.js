export default {
	async fetch(request, env) {
		if (request.headers.get("authorization") !== `Bearer ${env.SPIKE_SECRET}`) {
			return new Response("forbidden", { status: 403 });
		}
		const url = new URL(request.url);
		try {
			if (request.method === "POST" && url.pathname === "/repos") {
				const body = await request.json().catch(() => ({}));
				const created = await env.ARTIFACTS.create(body.name, {
					setDefaultBranch: "main",
					description: "throwaway spike-1 round trip",
				});
				return Response.json({ name: created.name, remote: created.remote });
			}
			if (request.method === "POST" && url.pathname === "/tokens") {
				const body = await request.json();
				const repo = await env.ARTIFACTS.get(body.name);
				const token = await repo.createToken("write", 600);
				return Response.json({ plaintext: token.plaintext, expiresAt: token.expiresAt });
			}
			if (request.method === "GET" && url.pathname === "/file") {
				const repo = await env.ARTIFACTS.get(url.searchParams.get("repo"));
				const file = await repo.readFile({
					ref: url.searchParams.get("ref") ?? "main",
					path: url.searchParams.get("path"),
				});
				if (file === null) return new Response("not found", { status: 404 });
				return new Response(file, { headers: { "content-type": file.type } });
			}
			return new Response("not found", { status: 404 });
		} catch (e) {
			return Response.json({ error: String(e) }, { status: 500 });
		}
	},
};
