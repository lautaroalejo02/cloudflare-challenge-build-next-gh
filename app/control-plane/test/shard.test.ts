import test from "node:test";
import assert from "node:assert/strict";
import {
	COMPONENT_EPOCH,
	componentFromInstance,
	componentInstance,
	componentName,
	emptyRouterState,
	mergeEvents,
	mergeStates,
	repoToEntryId,
	resetRouterState,
} from "../src/shard.ts";
import { initialState, publicState } from "../src/rob.ts";

test("componentName derives the DO name from the root entry id", () => {
	assert.equal(componentName("e1"), "comp-e1");
	assert.equal(componentName("e42"), "comp-e42");
});

test("repoToEntryId parses fork names incl. -xN alias suffixes", () => {
	assert.equal(repoToEntryId("arb-e7-ui-0"), "e7");
	assert.equal(repoToEntryId("arb-e7-ui-0-x12"), "e7");
	assert.equal(repoToEntryId("arb-e123-tests-3"), "e123");
	assert.equal(repoToEntryId("arb-trunk"), null);
	assert.equal(repoToEntryId("arb-e-x"), null);
	assert.equal(repoToEntryId("something-else"), null);
});

test("mergeStates concatenates entries by seq, sums stats, takes trunk head", () => {
	const a = initialState();
	a.entries.push(
		{ id: "e1", seq: 1, agent: "a", lane: "api", status: "retired", repo: "r1", remote: "", producerId: null, baseCommit: "b", headCommit: "h", exports: {}, consumes: {}, predicted: [], generation: 0, diagnosis: null, checks: null },
		{ id: "e3", seq: 3, agent: "u", lane: "ui", status: "ready", repo: "r3", remote: "", producerId: "e1", baseCommit: "b", headCommit: "h", exports: {}, consumes: {}, predicted: [], generation: 0, diagnosis: null, checks: null },
	);
	a.stats.squashes = 2;
	a.stats.retired = 1;
	a.trunk.retiredCount = 1;
	const b = initialState();
	b.entries.push(
		{ id: "e2", seq: 2, agent: "p", lane: "api", status: "retired", repo: "r2", remote: "", producerId: null, baseCommit: "b", headCommit: "h", exports: {}, consumes: {}, predicted: [], generation: 0, diagnosis: null, checks: null },
	);
	b.stats.earlyCutoffs = 4;
	b.stats.retired = 1;
	b.trunk.retiredCount = 1;
	const merged = mergeStates([publicState(a), publicState(b)], { repo: "arb-trunk", commit: "HEAD" }, 8);
	assert.deepEqual(merged.entries.map((e) => e.id), ["e1", "e2", "e3"]);
	assert.equal(merged.stats.squashes, 2);
	assert.equal(merged.stats.earlyCutoffs, 4);
	assert.equal(merged.stats.retired, 2);
	assert.equal(merged.trunk.commit, "HEAD");
	assert.equal(merged.trunk.retiredCount, 2);
	assert.equal(merged.robSize, 8);
});

test("mergeEvents unions event logs ordered by ts and caps at 200", () => {
	const mk = (ts: number, entryId?: string) => ({ type: "push" as const, ts, entryId });
	const a = [mk(1, "e1"), mk(5, "e1"), mk(9, "e3")];
	const b = [mk(2, "e2"), mk(6, "e2")];
	const merged = mergeEvents([a, b]);
	assert.deepEqual(merged.map((e) => e.ts), [1, 2, 5, 6, 9]);
	const big = Array.from({ length: 150 }, (_, i) => mk(i));
	const bigger = Array.from({ length: 150 }, (_, i) => mk(1000 + i));
	assert.equal(mergeEvents([big, bigger]).length, 200);
	assert.equal(mergeEvents([big, bigger])[199].ts, 1149);
});

// --- T19 review F1/F10: router reset + DO instance naming ----------------------

test("resetRouterState keeps nextSeq monotonic and the trunk, restores robSize, clears routing (F1/F10)", () => {
	const before = {
		...emptyRouterState(),
		nextSeq: 7,
		entryComp: { e7: "comp-e7" },
		repoComp: { "arb-e7-api-0": "comp-e7" },
		components: ["comp-e7"],
		trunk: { repo: "arb-trunk", remote: "https://x/arb-trunk", commit: "t1" },
		robSize: 3,
	};
	const after = resetRouterState(before);
	assert.equal(after.nextSeq, 7, "seq continues after reset: fresh repo names, no -xN collisions");
	assert.deepEqual(after.trunk, before.trunk);
	assert.equal(after.robSize, emptyRouterState().robSize);
	assert.deepEqual([after.entryComp, after.repoComp, after.components], [{}, {}, []]);
});

test("component DO instance names are epoch-scoped and round-trip to the public name (F10)", () => {
	const inst = componentInstance("comp-e3");
	assert.notEqual(inst, "comp-e3");
	assert.ok(inst.includes(COMPONENT_EPOCH));
	assert.equal(componentFromInstance(inst), "comp-e3");
	assert.equal(componentFromInstance("comp-e3"), "comp-e3");
});
