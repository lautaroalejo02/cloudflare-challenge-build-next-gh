import { buildModuleMap } from "./module-map.ts";
import { buildRunnerSource, RUNNER_MODULE } from "./runner.ts";

export interface CheckResult {
	commit: string;
	passed: number;
	failed: number;
	durationMs: number;
	results: Array<{ name: string; ok: boolean; error?: string }>;
}

export interface CheckerEnv {
	ARTIFACTS: any;
	LOADER: any;
}

const COMPAT_DATE = "2026-10-12";
const LOADER_ID_PREFIX = "arb-checker";

function failedResult(commit: string, error: string, durationMs: number): CheckResult {
	return { commit, passed: 0, failed: 1, durationMs, results: [{ name: "checker", ok: false, error }] };
}

/**
 * Reads every file at `commit` of `repo`, strips TypeScript types, loads the result as a
 * Dynamic Worker, and runs every module matching `tests/**\/*.test.ts`. Each test module
 * must export `async function run(): Promise<Array<{name, ok, error?}>>`.
 * Never throws: any failure is reported as a failed check.
 */
export async function runChecks(env: CheckerEnv, repo: string, commit: string): Promise<CheckResult> {
	const t0 = performance.now();
	const elapsed = () => Math.round((performance.now() - t0) * 10) / 10;
	try {
		using handle = await env.ARTIFACTS.get(repo);
		const [meta] = await handle.log({ ref: commit, limit: 1 });
		if (!meta) return failedResult(commit, `commit not found: ${commit}`, elapsed());
		const sha = meta.hash;

		// The same commit always maps to the same loader id, so repeat checks hit the
		// per-machine isolate cache and skip the module-map build entirely.
		const stub = env.LOADER.get(`${LOADER_ID_PREFIX}:${repo}:${sha}`, async () => {
			const { modules, testModules } = await buildModuleMap(handle, sha);
			modules[RUNNER_MODULE] = { js: buildRunnerSource(testModules) };
			return {
				compatibilityDate: COMPAT_DATE,
				mainModule: RUNNER_MODULE,
				modules,
				globalOutbound: null,
			};
		});

		const res = await stub.getEntrypoint().fetch("https://arb-checker.invalid/run");
		const body = await res.json().catch(() => null) as { results?: CheckResult["results"] } | null;
		if (!res.ok || !body || !Array.isArray(body.results)) {
			const detail = body ? JSON.stringify(body).slice(0, 500) : `HTTP ${res.status}`;
			return failedResult(sha, `dynamic worker returned an invalid response: ${detail}`, elapsed());
		}
		const results = body.results;
		return {
			commit: sha,
			passed: results.filter((r) => r.ok).length,
			failed: results.filter((r) => !r.ok).length,
			durationMs: elapsed(),
			results,
		};
	} catch (err) {
		return failedResult(commit, String((err && ((err as Error).stack || (err as Error).message)) || err), elapsed());
	}
}
