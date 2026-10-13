import { buildModuleMap, type RepoHandle } from "./module-map.ts";
import { errorText, withRetry, type RetryOptions } from "./retry.ts";
import { buildRunnerSource, RUNNER_MODULE } from "./runner.ts";

export interface CheckResult {
	commit: string;
	passed: number;
	failed: number;
	durationMs: number;
	results: Array<{ name: string; ok: boolean; error?: string }>;
	/** True when the checker could not run the tests at all (Artifacts,
	 * loader or network failure): an infra error, NOT a test verdict (T19). */
	infra?: boolean;
}

export interface CheckerEnv {
	ARTIFACTS: any;
	LOADER: any;
}

export interface RunChecksOptions {
	/** Backoff sleep for transient Artifacts retries (tests inject a no-op). */
	sleep?: (ms: number) => Promise<void>;
}

const COMPAT_DATE = "2026-10-12";
const LOADER_ID_PREFIX = "arb-checker";

/** Marks an error raised by the platform (Artifacts/loader), not by the code
 * under test. */
class InfraError extends Error {}

function failedResult(commit: string, error: string, durationMs: number, infra = false): CheckResult {
	const r: CheckResult = { commit, passed: 0, failed: 1, durationMs, results: [{ name: "checker", ok: false, error }] };
	if (infra) r.infra = true;
	return r;
}

/** Wrap the Artifacts repo handle: every read retries transient failures
 * with backoff, and a read that still fails is tagged as infra. */
function retryingRepo(handle: RepoHandle, retry: RetryOptions): RepoHandle {
	const wrap =
		<A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
		async (...a: A): Promise<R> => {
			try {
				return await withRetry(() => fn(...a), retry);
			} catch (err) {
				throw new InfraError(`artifacts read failed: ${errorText(err)}`);
			}
		};
	return {
		log: wrap((o) => handle.log(o)),
		readTree: wrap((h) => handle.readTree(h)),
		readBlob: wrap((h) => handle.readBlob(h)),
	};
}

/**
 * Reads every file at `commit` of `repo`, strips TypeScript types, loads the result as a
 * Dynamic Worker, and runs every module matching `tests/**\/*.test.ts`. Each test module
 * must export `async function run(): Promise<Array<{name, ok, error?}>>`.
 * Never throws: a test failure is a failed check; a platform failure (Artifacts, Worker
 * Loader) is a failed check flagged `infra: true` so callers do not treat it as a verdict.
 */
export async function runChecks(env: CheckerEnv, repo: string, commit: string, opts: RunChecksOptions = {}): Promise<CheckResult> {
	const t0 = performance.now();
	const elapsed = () => Math.round((performance.now() - t0) * 10) / 10;
	const retry: RetryOptions = { sleep: opts.sleep };
	let raw: (RepoHandle & { [k: symbol]: unknown }) | null = null;
	try {
		try {
			raw = await withRetry(() => env.ARTIFACTS.get(repo), retry);
		} catch (err) {
			return failedResult(commit, `artifacts get failed: ${errorText(err)}`, elapsed(), true);
		}
		const handle = retryingRepo(raw!, retry);
		const [meta] = await handle.log({ ref: commit, limit: 1 });
		// The control plane only checks commits it observed via log(): a miss
		// is replication lag / a platform fault, not a verdict on the code.
		if (!meta) return failedResult(commit, `commit not found: ${commit}`, elapsed(), true);
		const sha = meta.hash;

		// The same commit always maps to the same loader id, so repeat checks hit the
		// per-machine isolate cache and skip the module-map build entirely.
		let res: Response;
		try {
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
			res = await stub.getEntrypoint().fetch("https://arb-checker.invalid/run");
		} catch (err) {
			// Module-map read failures arrive here already tagged; a syntax
			// error stripping the code under test is a verdict; anything else
			// thrown by the loader itself is the platform.
			if (err instanceof InfraError) throw err;
			const msg = String((err as Error)?.message ?? err);
			if (err instanceof SyntaxError || /SyntaxError|Unexpected token|No such module|Cannot find module|module not found/i.test(msg)) {
				return failedResult(sha, errorText(err, 500), elapsed());
			}
			return failedResult(sha, `worker loader failed: ${errorText(err)}`, elapsed(), true);
		}
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
		if (err instanceof InfraError) return failedResult(commit, err.message, elapsed(), true);
		return failedResult(commit, errorText(err, 500), elapsed());
	} finally {
		const dispose = raw?.[Symbol.dispose as symbol];
		if (typeof dispose === "function") dispose.call(raw);
	}
}
