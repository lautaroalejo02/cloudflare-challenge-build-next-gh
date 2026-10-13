import { runChecks } from "./index.ts";

export default {
	async fetch(request: Request, env: any): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname !== "/check") {
			return new Response("GET /check?repo=<name>&commit=<sha>", { status: 404 });
		}
		const repo = url.searchParams.get("repo") ?? "arb-test-checker-fixture";
		const commit = url.searchParams.get("commit");
		if (!commit) return Response.json({ error: "commit query param required" }, { status: 400 });
		const t0 = performance.now();
		const check = await runChecks(env, repo, commit);
		return Response.json({ check, totalMs: Math.round((performance.now() - t0) * 10) / 10 });
	},
};
