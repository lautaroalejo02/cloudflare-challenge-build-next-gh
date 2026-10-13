// T14: index-map consistency tests for the pure state machine.
// `apply()` maintains `_internal.idx` — id->seq, repo->id, producerId->
// children, pending repo reverse map, a monotone head cursor and the
// non-retired counter. These tests recompute the indexes from scratch after
// every command and assert they match, across create / fork / squash /
// re-fork / retire / veto / reset, plus the JSON persistence roundtrip.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	apply,
	initialState,
	type ApplyResult,
	type Cmd,
	type Effect,
	type RobIndexes,
	type RobState,
} from "../src/rob.ts";

const NOW = 1_700_000_000_000;

function ok(r: ApplyResult): RobState {
	assert.equal(r.ok, true, r.ok ? "" : `apply failed: ${r.error}`);
	return (r as { state: RobState }).state;
}
function eff(r: ApplyResult): Effect[] {
	assert.equal(r.ok, true, r.ok ? "" : `apply failed: ${r.error}`);
	return (r as { effects: Effect[] }).effects;
}
function run(state: RobState, cmd: Cmd): RobState {
	const s = ok(apply(state, cmd, NOW));
	assertIdx(s);
	return s;
}
function runEff(state: RobState, cmd: Cmd): { state: RobState; effects: Effect[] } {
	const r = apply(state, cmd, NOW);
	const s = { state: ok(r), effects: eff(r) };
	assertIdx(s.state);
	return s;
}

/** What the indexes must contain, recomputed linearly from entries+pending. */
function expectedIdx(state: RobState): RobIndexes {
	const byId: Record<string, number> = {};
	const byRepo: Record<string, string> = {};
	const childrenOf: Record<string, string[]> = {};
	const pendingRepo: Record<string, string> = {};
	let active = 0;
	let lastSeq = 0;
	for (const e of state.entries) {
		byId[e.id] = e.seq;
		if (e.repo) byRepo[e.repo] = e.id;
		if (e.producerId) (childrenOf[e.producerId] ??= []).push(e.id);
		if (e.status !== "retired") active += 1;
		if (e.seq > lastSeq) lastSeq = e.seq;
	}
	for (const [id, repo] of Object.entries(state._internal.pending)) pendingRepo[repo] = id;
	const live = (s: string) => s !== "retired" && s !== "vetoed";
	let headCursor = 0;
	while (headCursor < state.entries.length && !live(state.entries[headCursor].status)) headCursor++;
	return { byId, byRepo, childrenOf, pendingRepo, headCursor, active, lastSeq, n: state.entries.length };
}

function assertIdx(state: RobState): void {
	const idx = state._internal.idx;
	assert.ok(idx, "state._internal.idx missing");
	// Entries must stay sorted by seq (binary-search invariant).
	for (let i = 1; i < state.entries.length; i++) {
		assert.ok(
			state.entries[i - 1].seq < state.entries[i].seq,
			`entries not sorted by seq at ${i}: ${state.entries[i - 1].seq} !< ${state.entries[i].seq}`,
		);
	}
	const want = expectedIdx(state);
	const { childrenOf: gotChildren, ...gotRest } = idx;
	const { childrenOf: wantChildren, ...wantRest } = want;
	assert.deepEqual(gotRest, wantRest);
	for (const k of new Set([...Object.keys(gotChildren), ...Object.keys(wantChildren)])) {
		assert.deepEqual(
			[...(gotChildren[k] ?? [])].sort(),
			[...(wantChildren[k] ?? [])].sort(),
			`childrenOf[${k}]`,
		);
	}
}

function trunked(commit = "t0"): RobState {
	return run(initialState(), { type: "trunk.init", repo: "arb-trunk", remote: "https://x/arb-trunk", commit });
}

/** Create an entry (with optional explicit id/seq) and complete its fork. */
function created(
	state: RobState,
	opts: { agent: string; lane: string; producerId?: string; consumes?: string[]; id?: string; seq?: number },
	base: { commit: string; exports?: Record<string, string>; sigs?: Record<string, string> },
): { state: RobState; id: string } {
	// apply() mutates state in place: the expected id must be computed before entry.create runs.
	const id = opts.id ?? `e${opts.seq ?? Number(state._internal.idx?.lastSeq ?? state.entries.length) + 1}`;
	const r = runEff(state, { type: "entry.create", ...opts });
	const s2 = run(r.state, {
		type: "fork.done",
		entryId: id,
		repo: r.effects.find((e) => e.type === "fork")!.toRepo,
		remote: `https://x/${id}`,
		baseCommit: base.commit,
		exports: base.exports ?? {},
		sigs: base.sigs ?? {},
	});
	return { state: s2, id };
}

test("indexes stay consistent across create/fork/squash/refork/retire/veto/reset", () => {
	let s = trunked();
	assertIdx(s);

	// Chain: e1 (api) -> e2 (ui) -> e3 (tests); e4 is an independent root.
	s = created(s, { agent: "a", lane: "api" }, {
		commit: "p1", exports: { createOrder: "h1" }, sigs: { createOrder: "sig1" },
	}).state;
	s = created(s, { agent: "u", lane: "ui", producerId: "e1", consumes: ["createOrder"] }, {
		commit: "p1", exports: { createOrder: "h1", checkout: "u1" },
	}).state;
	s = created(s, { agent: "t", lane: "tests", producerId: "e2", consumes: ["checkout"] }, {
		commit: "p1", exports: { createOrder: "h1", checkout: "u1" },
	}).state;
	s = created(s, { agent: "x", lane: "docs" }, { commit: "p1" }).state;

	// Producer push squashes e2 and transitively e3 (interface change).
	s = run(s, {
		type: "push", repo: "arb-e1-api-0", commit: "p2",
		exports: { createOrder: "h2" }, sigs: { createOrder: "sig2" },
	});
	assert.equal(s._internal.idx!.pendingRepo["arb-e2-ui-1"], "e2");
	assert.equal(s._internal.idx!.pendingRepo["arb-e3-tests-1"], "e3");

	// Re-forks land (e3 under a collision suffix — repo moves).
	s = run(s, {
		type: "fork.done", entryId: "e2", repo: "arb-e2-ui-1",
		remote: "https://x/e2g1", baseCommit: "p2", exports: { createOrder: "h2", checkout: "u1" },
	});
	s = run(s, {
		type: "fork.done", entryId: "e3", repo: "arb-e3-tests-1-x1",
		remote: "https://x/e3g1", baseCommit: "p2", exports: { createOrder: "h2", checkout: "u1" },
	});
	assert.equal(s._internal.idx!.byRepo["arb-e3-tests-1-x1"], "e3");
	assert.equal(s._internal.idx!.byRepo["arb-e3-tests-1"], undefined);
	assert.equal(s._internal.idx!.pendingRepo["arb-e3-tests-1"], undefined);

	// Ready -> check -> retire e1 (head cursor advances past it).
	s = run(s, { type: "entry.ready", entryId: "e1", commit: "p2" });
	s = run(s, {
		type: "check.done", entryId: "e1",
		result: { commit: "p2", passed: 1, failed: 0, durationMs: 5, results: [] },
	});
	s = run(s, { type: "retire.done", entryId: "e1", commit: "trunk1" });
	assert.equal(s._internal.idx!.active, 3);

	// Veto the new head (e2): e3 is squashed and reparented to e2's producer
	// (e1). The vetoed entry itself keeps producerId=e1 and is not re-forked.
	const { state: s2 } = runEff(s, { type: "entry.veto", entryId: "e2" });
	s = s2;
	assert.equal(s._internal.idx!.byId["e2"], 2);
	assert.deepEqual([...(s._internal.idx!.childrenOf["e1"] ?? [])].sort(), ["e2", "e3"]);
	assert.deepEqual(s._internal.idx!.childrenOf["e2"] ?? [], []);
	assert.equal(s._internal.idx!.pendingRepo["arb-e3-tests-2"], "e3");

	// Reset clears every index.
	s = run(s, { type: "reset" });
	assert.deepEqual(s._internal.idx, {
		byId: {}, byRepo: {}, childrenOf: {}, pendingRepo: {},
		headCursor: 0, active: 0, lastSeq: 0, n: 0,
	});
});

test("indexes survive a JSON persistence roundtrip (rebuild on load)", () => {
	let s = trunked();
	s = created(s, { agent: "a", lane: "api" }, {
		commit: "p1", exports: { createOrder: "h1" }, sigs: { createOrder: "sig1" },
	}).state;
	s = created(s, { agent: "u", lane: "ui", producerId: "e1", consumes: ["createOrder"] }, {
		commit: "p1", exports: { createOrder: "h1" },
	}).state;

	// Simulate a DO restart on a state persisted before indexes existed.
	const loaded: RobState = JSON.parse(JSON.stringify(s));
	delete (loaded._internal as { idx?: unknown }).idx;
	let r = apply(loaded, {
		type: "push", repo: "arb-e1-api-0", commit: "p2",
		exports: { createOrder: "h2" }, sigs: { createOrder: "sig2" },
	}, NOW);
	assert.equal(r.ok, true);
	s = ok(r);
	assertIdx(s);
	// Semantics identical to the indexed path: consumer squashed once.
	assert.equal(s.entries.find((e) => e.id === "e2")!.status, "squashed");
	assert.equal(s.stats.squashes, 1);
});

test("out-of-order seq allocation keeps entries sorted and the head cursor correct", () => {
	let s = trunked();
	// The router hands out seqs before the component DO sees the create;
	// two creates racing on one component can arrive out of order.
	s = created(s, { agent: "hi", lane: "api", id: "e9", seq: 9 }, { commit: "p1" }).state;
	s = created(s, { agent: "lo", lane: "ui", id: "e2", seq: 2 }, { commit: "p1" }).state;
	assert.deepEqual(s.entries.map((e) => e.id), ["e2", "e9"]);
	assert.equal(s._internal.idx!.lastSeq, 9);

	// The lower-seq entry is head: vetoing the higher-seq one is rejected.
	const bad = apply(s, { type: "entry.veto", entryId: "e9" }, NOW);
	assert.equal(bad.ok, false);
	const r = runEff(s, { type: "entry.veto", entryId: "e2" });
	assert.equal(r.state.entries.find((e) => e.id === "e2")!.status, "vetoed");
});

test("repo index routes pushes only to the entry's current repo", () => {
	let s = trunked();
	s = created(s, { agent: "a", lane: "api" }, {
		commit: "p1", exports: { createOrder: "h1" }, sigs: { createOrder: "sig1" },
	}).state;
	s = created(s, { agent: "u", lane: "ui", producerId: "e1", consumes: ["createOrder"] }, {
		commit: "p1", exports: { createOrder: "h1" },
	}).state;
	// Squash e2, refork under a new name; pushes to the OLD name are ignored.
	s = run(s, {
		type: "push", repo: "arb-e1-api-0", commit: "p2",
		exports: { createOrder: "h2" }, sigs: { createOrder: "sig2" },
	});
	s = run(s, {
		type: "fork.done", entryId: "e2", repo: "arb-e2-ui-1",
		remote: "https://x/e2g1", baseCommit: "p2", exports: { createOrder: "h2" },
	});
	s = run(s, { type: "push", repo: "arb-e2-ui-0", commit: "STALE", exports: { createOrder: "hz" } });
	assert.equal(s.entries.find((e) => e.id === "e2")!.headCommit, "p2");
	s = run(s, { type: "push", repo: "arb-e2-ui-1", commit: "q1", exports: { createOrder: "h2" } });
	assert.equal(s.entries.find((e) => e.id === "e2")!.headCommit, "q1");
});
