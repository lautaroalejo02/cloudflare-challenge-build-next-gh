// (V2) TypeSafe System One ("Jev") semantic judge: one POST per consumer,
// one Noul question per body-changed symbol. Contract: app/CONTRACTS.md
// "Jev semantic judgment". The API key only ever leaves this module inside
// the request's Authorization header — every returned/thrown value is
// sanitized to a fixed reason string.

import type { JudgeVerdict } from "./rob.ts";

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";

const QUESTION =
	"The change from `producer.before` to `producer.after` alters behavior that the code in `consumer.usage` relies on, so that code would now be incorrect or produce different results.";
const CRITERIA = {
	true: "The consumer's observable results or correctness change.",
	false: "Pure refactor or an internal change the consumer cannot observe.",
} as const;

/** One body-changed producer symbol to judge. `before`/`after` are the
 * declaration source texts; `usage` is the consumer's importing files. */
export interface JudgeSymbolInput {
	symbol: string;
	before: string;
	after: string;
	usage: { file: string; code: string }[];
}

export interface JudgeInput {
	producer: JudgeSymbolInput[];
	consumer: { agent: string; lane: string };
}

export interface JevOptions {
	apiKey?: string;
	fetch: typeof globalThis.fetch;
	/** Per-attempt timeout (contract default 8 s). */
	timeoutMs?: number;
	/** Backoff between retries (test seam; default setTimeout). */
	sleep?: (ms: number) => Promise<void>;
}

interface NoulAnswer {
	type?: string;
	noul?: number;
}
interface SystemOneResponse {
	model?: string;
	answers?: Record<string, NoulAnswer>;
}

const nullVerdicts = (input: JudgeInput, reason: string): JudgeVerdict[] =>
	input.producer.map((p) => ({ symbol: p.symbol, probability: null, reason }));

const isRetryable = (status: number) => status === 429 || status === 529 || status >= 500;

/** Judge every symbol in `input` in a single request. Never throws and
 * never leaks the API key: failures become `probability: null` verdicts
 * with a short fixed reason (`no-api-key`, `http-401`, `timeout`,
 * `fetch-error`, `bad-response`, `missing-answer`). */
export async function judgeBehavior(input: JudgeInput, opts: JevOptions): Promise<JudgeVerdict[]> {
	const { apiKey, timeoutMs = 8000 } = opts;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	if (!apiKey) return nullVerdicts(input, "no-api-key");

	const single = input.producer.length === 1;
	const usageSeen = new Set<string>();
	const allUsage: { file: string; code: string }[] = [];
	for (const p of input.producer) {
		for (const u of p.usage) {
			if (usageSeen.has(u.file)) continue;
			usageSeen.add(u.file);
			allUsage.push({ file: u.file, code: u.code });
		}
	}
	const body = {
		state: {
			producer: single
				? { symbol: input.producer[0].symbol, before: input.producer[0].before, after: input.producer[0].after }
				: input.producer.map((p) => ({ symbol: p.symbol, before: p.before, after: p.after })),
			consumer: { agent: input.consumer.agent, lane: input.consumer.lane, usage: allUsage },
		},
		model: JEV_MODEL,
		questions: Object.fromEntries(
			input.producer.map((p, i) => [
				`s${i}`, // positional ids: safe for arbitrary symbol names
				{
					type: "noul",
					instructions: {
						question: QUESTION,
						producer: { symbol: p.symbol, before: p.before, after: p.after },
						consumer: { usage: p.usage },
					},
					criteria: { ...CRITERIA },
				},
			]),
		),
	};

	let lastReason = "fetch-error";
	for (let attempt = 0; attempt < 3; attempt++) {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), timeoutMs);
		let res: Response | null = null;
		try {
			res = await opts.fetch(JEV_URL, {
				method: "POST",
				headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal: ac.signal,
			});
		} catch (e) {
			// Sanitized: fetch errors may embed request details.
			lastReason = e instanceof DOMException && e.name === "AbortError" ? "timeout" : "fetch-error";
		} finally {
			clearTimeout(timer);
		}
		if (!res) {
			if (attempt < 2) await sleep(attempt === 0 ? 500 : 1000);
			continue;
		}
		if (!res.ok) {
			if (!isRetryable(res.status)) return nullVerdicts(input, `http-${res.status}`);
			lastReason = `http-${res.status}`;
			if (attempt < 2) await sleep(attempt === 0 ? 500 : 1000);
			continue;
		}
		let data: SystemOneResponse;
		try {
			data = (await res.json()) as SystemOneResponse;
		} catch {
			return nullVerdicts(input, "bad-response");
		}
		if (!data.answers || typeof data.answers !== "object") return nullVerdicts(input, "bad-response");
		return input.producer.map((p, i) => {
			const a = data.answers![`s${i}`];
			const p2 = a && typeof a.noul === "number" && a.noul >= 0 && a.noul <= 1 ? a.noul : null;
			return p2 === null
				? { symbol: p.symbol, probability: null, reason: "missing-answer" }
				: { symbol: p.symbol, probability: p2, model: data.model ?? JEV_MODEL };
		});
	}
	return nullVerdicts(input, lastReason);
}
