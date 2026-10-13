/**
 * arb-test-retirer — throwaway Worker proving fast-forward retirement.
 *
 * Routes (all JSON unless noted):
 *   POST /setup  { trunk?, fork? }          -> create trunk repo, fork it, mint write tokens for both
 *   POST /token  { name, scope?, ttl? }     -> mint an Artifacts token for a repo
 *   GET  /head?repo=&branch=                -> current oid of refs/heads/<branch> (null if unborn)
 *   POST /ff     { fromRepo, commit, toRepo, branch? } -> fastForward(); 409 on NOT_FAST_FORWARD
 *   GET  /info?repo=                        -> repo.info()
 */
import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { fastForward, NotFastForwardError, type ArtifactsRepoHandle } from "./retire.ts";

interface RepoHandle extends ArtifactsRepoHandle {
	fork(name: string, opts?: Record<string, unknown>): Promise<{ name: string; remote: string }>;
}

interface Env {
	ARTIFACTS: {
		create(name: string, opts?: Record<string, unknown>): Promise<{ name: string; remote: string }>;
		get(name: string): Promise<RepoHandle>;
	};
}

function stripExpiry(plaintext: string): string {
	return plaintext.split("?expires=")[0];
}

async function tokenFor(env: Env, name: string, scope: string, ttl: number): Promise<string> {
	const repo = await env.ARTIFACTS.get(name);
	try {
		const tok = await repo.createToken(scope, ttl);
		return stripExpiry(tok.plaintext);
	} finally {
		repo[Symbol.dispose]?.();
	}
}

function credUrl(remote: string, token: string): string {
	return remote.startsWith("https://") ? `https://x:${token}@${remote.slice(8)}` : remote;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const body: Record<string, unknown> =
			request.method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {};

		try {
			if (request.method === "POST" && url.pathname === "/setup") {
				const trunk = String(body.trunk ?? "arb-test-retirer-trunk");
				const fork = String(body.fork ?? "arb-test-retirer-fork");
				const created = await env.ARTIFACTS.create(trunk, {
					setDefaultBranch: "main",
					description: "arb retirer spike trunk (throwaway)",
				});
				const trunkRepo = await env.ARTIFACTS.get(trunk);
				let forked;
				try {
					forked = await trunkRepo.fork(fork, { description: "arb retirer spike fork (throwaway)" });
				} finally {
					trunkRepo[Symbol.dispose]?.();
				}
				const [trunkToken, forkToken] = await Promise.all([
					tokenFor(env, trunk, "write", 3600),
					tokenFor(env, fork, "write", 3600),
				]);
				return Response.json({
					trunk: { name: created.name, remote: created.remote, token: trunkToken },
					fork: { name: forked.name, remote: forked.remote, token: forkToken },
				});
			}

			if (request.method === "POST" && url.pathname === "/token") {
				const token = await tokenFor(env, String(body.name), String(body.scope ?? "write"), Number(body.ttl ?? 3600));
				return Response.json({ token });
			}

			if (request.method === "GET" && url.pathname === "/info") {
				const repo = await env.ARTIFACTS.get(String(url.searchParams.get("repo")));
				try {
					return Response.json(await repo.info());
				} finally {
					repo[Symbol.dispose]?.();
				}
			}

			if (request.method === "GET" && url.pathname === "/head") {
				const repo = String(url.searchParams.get("repo"));
				const branch = String(url.searchParams.get("branch") ?? "main");
				const token = await tokenFor(env, repo, "read", 300);
				const handle = await env.ARTIFACTS.get(repo);
				try {
					const { remote } = await handle.info();
					const refs = await git.listServerRefs({
						http,
						url: credUrl(remote, token),
						prefix: `refs/heads/${branch}`,
						protocolVersion: 1,
						onAuth: () => ({ username: "x", password: token }),
					});
					const head = refs.find((r) => r.ref === `refs/heads/${branch}`)?.oid ?? null;
					return Response.json({ repo, branch, head });
				} finally {
					handle[Symbol.dispose]?.();
				}
			}

			if (request.method === "POST" && url.pathname === "/ff") {
				const result = await fastForward(env, {
					fromRepo: String(body.fromRepo),
					commit: String(body.commit),
					toRepo: String(body.toRepo),
					branch: body.branch === undefined ? "main" : String(body.branch),
				});
				return Response.json(result);
			}

			return new Response("routes: POST /setup, POST /token, GET /head, GET /info, POST /ff", { status: 404 });
		} catch (e) {
			if (e instanceof NotFastForwardError) {
				return Response.json(
					{ error: e.message, code: e.code, commit: e.commit, ancestor: e.ancestor },
					{ status: 409 },
				);
			}
			const err = e as Error & { code?: string };
			return Response.json({ error: String(err?.stack || err?.message || err), code: err?.code }, { status: 500 });
		}
	},
};
