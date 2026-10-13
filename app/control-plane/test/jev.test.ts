// V2 tests for src/jev.ts — the TypeSafe System One ("Jev") client used by
// the judge effect. A fake `fetch` captures requests; no network is touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeBehavior, type JudgeInput } from "../src/jev.ts";

const KEY = "test-key-SECRET";

const QUESTION =
	"The change from `producer.before` to `producer.after` alters behavior that the code in `consumer.usage` relies on, so that code would now be incorrect or produce different results.";

const INPUT: JudgeInput = {
	producer: [
		{
			symbol: "createOrder",
			before: "export function createOrder(items: Item[]): Order { /* v1 */ }",
			after: "export function createOrder(items: Item[]): Order { /* v2 */ }",
			usage: [{ file: "src/ui/checkout.ts", code: "createOrder(cart)" }],
		},
	],
	consumer: { agent: "ui-agent", lane: "ui" },
};

interface Captured {
	url: string;
	method?: string;
	headers: Record<string, string>;
	body: unknown;
	signal?: AbortSignal | null;
}

/** A fetch stub whose queued handlers answer successive calls. */
function fakeFetch(handlers: Array<(init: RequestInit) => Response | Promise<Response>>) {
	const calls: Captured[] = [];
	const f = async (url: unknown, init: RequestInit = {}) => {
		calls.push({
			url: String(url),
			method: init.method,
			headers: (init.headers ?? {}) as Record<string, string>,
			body: init.body ? JSON.parse(String(init.body)) : undefined,
			signal: init.signal,
		});
		const h = handlers.length > 1 ? handlers.shift()! : handlers[0];
		return h(init);
	};
	return { fetch: f as unknown as typeof globalThis.fetch, calls };
}

const okJson = (answers: Record<string, { noul?: number }>, model = "jev-1.13.0") =>
	() =>
		new Response(JSON.stringify({ model, answers, usage: { input_tokens: 1, output_tokens: 1 } }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});

const status = (code: number) => () => new Response("nope", { status: code });

const noSleep = async () => {};

test("judgeBehavior sends the contract payload: state, model, one noul question per symbol", async () => {
	const { fetch, calls } = fakeFetch([okJson({ s0: { noul: 0.9 } })]);
	const verdicts = await judgeBehavior(INPUT, { apiKey: KEY, fetch, sleep: noSleep });
	assert.equal(calls.length, 1);
	const c = calls[0];
	assert.equal(c.url, "https://api.typesafe.ai/v1/systemone");
	assert.equal(c.method, "POST");
	assert.equal(c.headers.Authorization, `Bearer ${KEY}`);
	assert.deepEqual(c.body, {
		state: {
			producer: { symbol: "createOrder", before: INPUT.producer[0].before, after: INPUT.producer[0].after },
			consumer: {
				agent: "ui-agent",
				lane: "ui",
				usage: [{ file: "src/ui/checkout.ts", code: "createOrder(cart)" }],
			},
		},
		model: "jev-latest",
		questions: {
			s0: {
				type: "noul",
				instructions: {
					question: QUESTION,
					producer: { symbol: "createOrder", before: INPUT.producer[0].before, after: INPUT.producer[0].after },
					consumer: { usage: [{ file: "src/ui/checkout.ts", code: "createOrder(cart)" }] },
				},
				criteria: {
					true: "The consumer's observable results or correctness change.",
					false: "Pure refactor or an internal change the consumer cannot observe.",
				},
			},
		},
	});
	assert.deepEqual(verdicts, [{ symbol: "createOrder", probability: 0.9, model: "jev-1.13.0" }]);
});

test("judgeBehavior issues ONE request for several symbols (question per symbol)", async () => {
	const input: JudgeInput = {
		producer: [
			{ ...INPUT.producer[0] },
			{ symbol: "Order", before: "B", after: "A", usage: [{ file: "src/ui/a.ts", code: "x" }] },
		],
		consumer: INPUT.consumer,
	};
	const { fetch, calls } = fakeFetch([okJson({ s0: { noul: 0.9 }, s1: { noul: 0.1 } })]);
	const verdicts = await judgeBehavior(input, { apiKey: KEY, fetch, sleep: noSleep });
	assert.equal(calls.length, 1);
	const body = calls[0].body as { questions: Record<string, unknown>; state: { producer: unknown } };
	assert.deepEqual(Object.keys(body.questions), ["s0", "s1"]);
	assert.ok(Array.isArray(body.state.producer), "multi-symbol state carries a producer array");
	assert.deepEqual(
		verdicts.map((v) => [v.symbol, v.probability]),
		[
			["createOrder", 0.9],
			["Order", 0.1],
		],
	);
});

test("judgeBehavior retries 429/529/5xx with backoff then succeeds", async () => {
	const { fetch, calls } = fakeFetch([status(429), okJson({ s0: { noul: 0.2 } })]);
	const sleeps: number[] = [];
	const verdicts = await judgeBehavior(INPUT, { apiKey: KEY, fetch, sleep: async (ms) => void sleeps.push(ms) });
	assert.equal(calls.length, 2);
	assert.deepEqual(sleeps, [500]);
	assert.equal(verdicts[0].probability, 0.2);

	const again = fakeFetch([status(529), status(500), okJson({ s0: { noul: 0.3 } })]);
	const sleeps2: number[] = [];
	const v2 = await judgeBehavior(INPUT, { apiKey: KEY, fetch: again.fetch, sleep: async (ms) => void sleeps2.push(ms) });
	assert.equal(again.calls.length, 3);
	assert.deepEqual(sleeps2, [500, 1000]);
	assert.equal(v2[0].probability, 0.3);
});

test("judgeBehavior returns null probability on 401, 422 and exhausted retries", async () => {
	for (const code of [401, 422]) {
		const { fetch, calls } = fakeFetch([status(code)]);
		const verdicts = await judgeBehavior(INPUT, { apiKey: KEY, fetch, sleep: noSleep });
		assert.equal(calls.length, 1, `${code} is not retried`);
		assert.equal(verdicts[0].probability, null);
		assert.match(verdicts[0].reason ?? "", new RegExp(String(code)));
	}
	const { fetch, calls } = fakeFetch([status(429)]);
	const verdicts = await judgeBehavior(INPUT, { apiKey: KEY, fetch, sleep: noSleep });
	assert.equal(calls.length, 3, "two retries then give up");
	assert.equal(verdicts[0].probability, null);
	assert.match(verdicts[0].reason ?? "", /429/);
});

test("judgeBehavior times each attempt out and reports null", async () => {
	const { fetch, calls } = fakeFetch([
		(init) =>
			new Promise<Response>((_, reject) => {
				init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
			}),
	]);
	const verdicts = await judgeBehavior(INPUT, { apiKey: KEY, fetch, timeoutMs: 5, sleep: noSleep });
	assert.ok(calls.length >= 1);
	assert.equal(verdicts[0].probability, null);
	assert.match(verdicts[0].reason ?? "", /timeout|abort/i);
});

test("judgeBehavior without an api key never fetches and reports null", async () => {
	const { fetch, calls } = fakeFetch([okJson({ s0: { noul: 1 } })]);
	const verdicts = await judgeBehavior(INPUT, { apiKey: undefined, fetch, sleep: noSleep });
	assert.equal(calls.length, 0);
	assert.equal(verdicts[0].probability, null);
	assert.match(verdicts[0].reason ?? "", /key/i);
});

test("the api key never appears in verdicts or thrown errors", async () => {
	// HTTP failure path.
	const { fetch } = fakeFetch([status(503)]);
	const verdicts = await judgeBehavior(INPUT, { apiKey: KEY, fetch, sleep: noSleep });
	assert.ok(!JSON.stringify(verdicts).includes(KEY));
	// Fetch-throw path (network error embedding nothing but its message).
	const boom = fakeFetch([
		() => {
			throw new Error(`connect ECONNREFUSED ${KEY}`);
		},
	]);
	const v2 = await judgeBehavior(INPUT, { apiKey: KEY, fetch: boom.fetch, sleep: noSleep });
	assert.equal(v2[0].probability, null);
	assert.ok(!JSON.stringify(v2).includes(KEY), "error text must be sanitized");
});
