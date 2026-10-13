import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRunnerSource, RUNNER_MODULE } from "../src/runner.ts";

test("runner source statically imports each test module", () => {
	const src = buildRunnerSource(["tests/order.test.ts", "tests/deep/util.test.ts"]);
	assert.match(src, /import \* as __m0 from "\.\/tests\/order\.test\.ts"/);
	assert.match(src, /import \* as __m1 from "\.\/tests\/deep\/util\.test\.ts"/);
	assert.match(src, /export default/);
	assert.match(src, /does not export run\(\)/);
});

test("generated runner executes and aggregates results", async () => {
	// simulate what the dynamic worker does: import test modules, call run(), aggregate.
	// here we evaluate the generated module's fetch handler with the suite inlined.
	const runnerSrc = buildRunnerSource([]);
	const mod = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(runnerSrc)}`);
	const res = await mod.default.fetch();
	assert.deepEqual(await res.json(), { results: [] });
});
