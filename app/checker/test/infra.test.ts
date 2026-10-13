// T19 review F2: infra failures are distinct from test verdicts, and
// Artifacts reads retry transient 5xx errors with backoff.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runChecks } from "../src/index.ts";
import { isTransient, RETRY_DELAYS_MS, withRetry } from "../src/retry.ts";

const SHA = "c".repeat(40);
const noSleep = async () => {};

class Http503 extends Error {
	status = 503;
	constructor() {
		super("artifacts: 503 Service Unavailable");
	}
}

/** Fake Artifacts handle: tests/a.test.ts at SHA. `failFirst` makes the
 * first N calls of each method throw a 503. */
function fakeArtifacts(opts: { failGet?: number; failLog?: number; failBlob?: number; source?: string } = {}) {
	const n = { get: 0, log: 0, blob: 0 };
	const source = opts.source ?? "export async function run() { return [{ name: 'a', ok: true }]; }";
	const handle = {
		async log(o?: { ref?: string }) {
			if (n.log++ < (opts.failLog ?? 0)) throw new Http503();
			return o?.ref === SHA ? [{ hash: SHA, treeHash: "root" }] : [];
		},
		async readTree(hash: string) {
			if (hash === "root") return [{ name: "tests", mode: "40000", hash: "tdir", type: "tree" }];
			if (hash === "tdir") return [{ name: "a.test.ts", mode: "100644", hash: "b1", type: "blob" }];
			return null;
		},
		async readBlob(_hash: string) {
			if (n.blob++ < (opts.failBlob ?? 0)) throw new Http503();
			return { text: async () => source, arrayBuffer: async () => new TextEncoder().encode(source).buffer as ArrayBuffer };
		},
	};
	const ARTIFACTS = {
		async get(_repo: string) {
			if (n.get++ < (opts.failGet ?? 0)) throw new Http503();
			return handle;
		},
	};
	return { ARTIFACTS, calls: n };
}

/** Fake Worker Loader: builds the module map (exercising the reads), then
 * answers like the generated runner would. */
const fakeLoader = {
	get(_id: string, factory: () => Promise<unknown>) {
		return {
			getEntrypoint() {
				return {
					async fetch() {
						await factory();
						return new Response(JSON.stringify({ results: [{ name: "a", ok: true }] }));
					},
				};
			},
		};
	},
};

test("isTransient: 5xx/429 status and network-ish messages are transient, 4xx is not", () => {
	assert.equal(isTransient(new Http503()), true);
	assert.equal(isTransient({ data: { statusCode: 502 } }), true);
	assert.equal(isTransient(Object.assign(new Error("x"), { status: 429 })), true);
	assert.equal(isTransient(new Error("fetch failed: ECONNRESET")), true);
	assert.equal(isTransient(Object.assign(new Error("not found"), { status: 404 })), false);
	assert.equal(isTransient(new SyntaxError("Unexpected token (1:13)")), false);
});

test("withRetry: retries transient errors with ~0.5 s / 1 s / 2 s backoff", async () => {
	const slept: number[] = [];
	let calls = 0;
	const v = await withRetry(
		async () => {
			if (++calls < 3) throw new Http503();
			return "ok";
		},
		{ sleep: async (ms) => void slept.push(ms) },
	);
	assert.equal(v, "ok");
	assert.deepEqual(slept, [500, 1000]);
	assert.deepEqual(RETRY_DELAYS_MS, [500, 1000, 2000]);
});

test("withRetry: a non-transient error is thrown immediately", async () => {
	let calls = 0;
	await assert.rejects(
		withRetry(async () => {
			calls++;
			throw new Error("bad request");
		}, { sleep: noSleep }),
		/bad request/,
	);
	assert.equal(calls, 1);
});

test("runChecks: transient Artifacts 503s are retried and the check passes", async () => {
	const { ARTIFACTS, calls } = fakeArtifacts({ failGet: 1, failLog: 2, failBlob: 1 });
	const r = await runChecks({ ARTIFACTS, LOADER: fakeLoader }, "repo", SHA, { sleep: noSleep });
	assert.equal(r.failed, 0, JSON.stringify(r));
	assert.equal(r.passed, 1);
	assert.equal(r.infra, undefined);
	assert.ok(calls.get >= 2 && calls.log >= 3);
});

test("runChecks: a persistent Artifacts outage is an infra result, not a verdict", async () => {
	const { ARTIFACTS } = fakeArtifacts({ failGet: 99 });
	const r = await runChecks({ ARTIFACTS, LOADER: fakeLoader }, "repo", SHA, { sleep: noSleep });
	assert.equal(r.infra, true);
	assert.equal(r.failed, 1);
	const err = r.results[0].error ?? "";
	assert.match(err, /503/);
	assert.doesNotMatch(err, /\n\s+at /, "no stack traces in check results");
});

test("runChecks: a loader failure is infra", async () => {
	const { ARTIFACTS } = fakeArtifacts();
	const loader = { get() { throw new Error("loader unavailable"); } };
	const r = await runChecks({ ARTIFACTS, LOADER: loader }, "repo", SHA, { sleep: noSleep });
	assert.equal(r.infra, true);
});

test("runChecks: an unparseable test file is a real verdict, not infra", async () => {
	const { ARTIFACTS } = fakeArtifacts({ source: "export const = ;" });
	const r = await runChecks({ ARTIFACTS, LOADER: fakeLoader }, "repo", SHA, { sleep: noSleep });
	assert.equal(r.failed, 1);
	assert.ok(!r.infra, JSON.stringify(r));
});
