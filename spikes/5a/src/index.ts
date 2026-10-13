import { getSandbox } from "@cloudflare/sandbox";
export { Sandbox as Spike5aSandbox } from "@cloudflare/sandbox";

interface Env {
	ARTIFACTS: any;
	SANDBOX: any;
}

function authedRemote(remote: string, token: string): string {
	const secret = token.split("?expires=")[0];
	return `https://x:${secret}@${remote.slice("https://".length)}`;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const t0 = Date.now();

		if (url.pathname === "/tools") {
			const sandbox = getSandbox(env.SANDBOX, "spike-5a");
			const r = await sandbox.exec("node -v; npm -v; git --version");
			return Response.json({ out: r.stdout, err: r.stderr, ms: Date.now() - t0 });
		}

		// 1. Mint a read token for the fork repo via the Artifacts binding.
		let remote: string;
		let token: string;
		{
			using repo = await env.ARTIFACTS.get("spike-5a-fork");
			const info = await repo.info();
			remote = info.remote;
			token = (await repo.createToken("read", 3600)).plaintext;
		}
		const tRepo = Date.now();

		// 2. Start (or reuse) the sandbox and clone the fork.
		const sandbox = getSandbox(env.SANDBOX, "spike-5a");
		await sandbox.setEnvVars({ ARTIFACTS_GIT_REMOTE: authedRemote(remote, token) });
		const clone = await sandbox.exec(
			"rm -rf /workspace/repo && git clone \"$ARTIFACTS_GIT_REMOTE\" /workspace/repo",
			{ timeout: 120_000 },
		);
		const tClone = Date.now();
		if (clone.exitCode !== 0) {
			return Response.json({ phase: "clone", exitCode: clone.exitCode, out: clone.stdout + clone.stderr, ms: tClone - t0 });
		}

		// 3. npm ci + npm test inside the sandbox.
		const ci = await sandbox.exec("npm ci", { cwd: "/workspace/repo", timeout: 120_000 });
		const tCi = Date.now();
		const test = await sandbox.exec("npm test", { cwd: "/workspace/repo", timeout: 120_000 });
		const tTest = Date.now();

		return Response.json({
			ms: { repoToken: tRepo - t0, clone: tClone - tRepo, npmCi: tCi - tClone, npmTest: tTest - tCi, total: tTest - t0 },
			exitCodes: { clone: clone.exitCode, ci: ci.exitCode, test: test.exitCode },
			testOutput: (test.stdout + test.stderr).slice(-1500),
		});
	},
};
