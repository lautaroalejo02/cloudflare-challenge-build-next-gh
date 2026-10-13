// Transient-failure retry with backoff (T19, review F2). Shared by the
// checker's Artifacts reads and the control plane's retirer.

/** Delay before retry n+1: ~0.5 s, 1 s, 2 s (three retries, four tries). */
export const RETRY_DELAYS_MS = [500, 1000, 2000];

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** HTTP 5xx / 429 (status on the error, or isomorphic-git's
 * `data.statusCode`) and network-shaped messages are transient. */
export function isTransient(err: unknown): boolean {
	const e = err as { status?: unknown; statusCode?: unknown; data?: { statusCode?: unknown }; message?: unknown } | null;
	const status =
		typeof e?.status === "number"
			? e.status
			: typeof e?.statusCode === "number"
				? e.statusCode
				: typeof e?.data?.statusCode === "number"
					? e.data.statusCode
					: undefined;
	if (status !== undefined) return status >= 500 || status === 429;
	const msg = String(e?.message ?? err);
	return /\b(5\d\d|429)\b|internal (server )?error|timed? ?out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network|unavailable|overloaded|try again|fetch failed/i.test(
		msg,
	);
}

export interface RetryOptions {
	delays?: number[];
	sleep?: (ms: number) => Promise<void>;
	retryable?: (err: unknown) => boolean;
}

/** Run `fn`, retrying transient failures after each delay in `delays`. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
	const delays = opts.delays ?? RETRY_DELAYS_MS;
	const sleep = opts.sleep ?? realSleep;
	const retryable = opts.retryable ?? isTransient;
	for (let i = 0; ; i++) {
		try {
			return await fn();
		} catch (err) {
			if (i >= delays.length || !retryable(err)) throw err;
			await sleep(delays[i]);
		}
	}
}

/** One-line, credential-scrubbed error text (no stack traces) for results
 * and events. */
export function errorText(err: unknown, max = 300): string {
	const msg = String((err as Error)?.message ?? err).split("\n")[0];
	return msg.replace(/(https?:\/\/)[^\s/"']*@/g, "$1***@").slice(0, max);
}
