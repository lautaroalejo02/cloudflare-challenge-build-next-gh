// T19 regression tests for the independent review (R1) findings that live in
// the pure state machine (src/rob.ts). Each test names its finding (F<n>).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	apply,
	FORK_RETRY_BASE_MS,
	INFRA_RECHECK_MS,
	initialState,
	STALE_MARKER_MS,
	type ApplyResult,
	type CheckResult,
	type Cmd,
	type Effect,
	type RobState,
} from "../src/rob.ts";

const NOW = 1_700_000_000_000;

function runEffAt(state: RobState, cmd: Cmd, now = NOW): { state: RobState; effects: Effect[] } {
	const r: ApplyResult = apply(state, cmd, now);
	assert.equal(r.ok, true, r.ok ? "" : `apply failed: ${r.error}`);
	const ok = r as { state: RobState; effects: Effect[] };
	return { state: ok.state, effects: ok.effects };
}

function run(state: RobState, cmd: Cmd, now = NOW): RobState {
	return runEffAt(state, cmd, now).state;
}

const forks = (effects: Effect[]) =>
	effects.filter((e): e is Extract<Effect, { type: "fork" }> => e.type === "fork");
const of = (effects: Effect[], type: Effect["type"]) => effects.filter((e) => e.type === type);
const events = (effects: Effect[], type?: string) =>
	effects
		.filter((e): e is Extract<Effect, { type: "broadcast" }> => e.type === "broadcast")
		.map((e) => e.event)
		.filter((ev) => !type || ev.type === type);

function entry(state: RobState, id: string) {
	const e = state.entries.find((x) => x.id === id);
	assert.ok(e, `entry ${id} missing`);
	return e!;
}

const pass = (commit: string): CheckResult => ({ commit, passed: 1, failed: 0, durationMs: 5, results: [] });
const fail = (commit: string): CheckResult => ({
	commit,
	passed: 0,
	failed: 1,
	durationMs: 5,
	results: [{ name: "t", ok: false, error: "boom" }],
});
const infra = (commit: string): CheckResult => ({
	commit,
	passed: 0,
	failed: 1,
	durationMs: 5,
	results: [{ name: "checker", ok: false, error: "artifacts 503" }],
	infra: true,
});

function trunked(): RobState {
	return run(initialState(), { type: "trunk.init", repo: "arb-trunk", remote: "https://x/arb-trunk", commit: "t0" });
}

/** Producer e1 (api) at p1 exporting createOrder=h1, consumer e2 (ui) on it. */
function producerConsumer(): RobState {
	let s = trunked();
	s = run(s, { type: "entry.create", agent: "api", lane: "api" });
	s = run(s, {
		type: "fork.done", entryId: "e1", repo: "arb-e1-api-0", remote: "https://x/e1",
		baseCommit: "p1", exports: { createOrder: "h1" }, sigs: { createOrder: "sig1" },
	});
	s = run(s, { type: "entry.create", agent: "ui", lane: "ui", producerId: "e1", consumes: ["createOrder"] });
	s = run(s, {
		type: "fork.done", entryId: "e2", repo: "arb-e2-ui-0", remote: "https://x/e2",
		baseCommit: "p1", exports: { createOrder: "h1" }, sigs: { createOrder: "sig1" },
	});
	return s;
}

/** Single entry e1 pushed to c1, readied and checked: a retire effect is in flight. */
function retiringOne(): RobState {
	let s = trunked();
	s = run(s, { type: "entry.create", agent: "api", lane: "api" });
	s = run(s, { type: "fork.done", entryId: "e1", repo: "arb-e1-api-0", remote: "https://x/e1", baseCommit: "t0", exports: {} });
	s = run(s, { type: "push", repo: "arb-e1-api-0", commit: "c1", exports: {} });
	s = run(s, { type: "entry.ready", entryId: "e1", commit: "c1" });
	const r = runEffAt(s, { type: "check.done", entryId: "e1", result: pass("c1") });
	assert.equal(of(r.effects, "retire").length, 1);
	assert.equal(r.state._internal.retiring["e1"], true);
	return r.state;
}

// --- F1: reset restores robSize ---------------------------------------------------

test("F1 reset restores robSize to its default", () => {
	let s = trunked();
	s = run(s, { type: "config.set", robSize: 2 });
	assert.equal(s.robSize, 2);
	s = run(s, { type: "reset" });
	assert.equal(s.robSize, initialState().robSize);
});

// --- F2: infra failures are not verdicts; re-ready re-checks ------------------

test("F2 re-ready on the same head after a failed check re-runs the check", () => {
	let s = trunked();
	s = run(s, { type: "entry.create", agent: "api", lane: "api" });
	s = run(s, { type: "fork.done", entryId: "e1", repo: "arb-e1-api-0", remote: "https://x/e1", baseCommit: "t0", exports: {} });
	s = run(s, { type: "push", repo: "arb-e1-api-0", commit: "c1", exports: {} });
	s = run(s, { type: "entry.ready", entryId: "e1", commit: "c1" });
	s = run(s, { type: "check.done", entryId: "e1", result: fail("c1") });
	assert.equal(entry(s, "e1").status, "failed");
	const r = runEffAt(s, { type: "entry.ready", entryId: "e1", commit: "c1" });
	assert.equal(of(r.effects, "check").length, 1, "a re-ready must re-check, not trust the failed verdict forever");
	assert.equal(entry(r.state, "e1").status, "checking");
});

test("F2 an infra check result is not stored as a verdict and is re-checked by the sweep", () => {
	let s = trunked();
	s = run(s, { type: "entry.create", agent: "api", lane: "api" });
	s = run(s, { type: "fork.done", entryId: "e1", repo: "arb-e1-api-0", remote: "https://x/e1", baseCommit: "t0", exports: {} });
	s = run(s, { type: "push", repo: "arb-e1-api-0", commit: "c1", exports: {} });
	s = run(s, { type: "entry.ready", entryId: "e1", commit: "c1" });
	const r = runEffAt(s, { type: "check.done", entryId: "e1", result: infra("c1") });
	s = r.state;
	assert.equal(entry(s, "e1").status, "checking");
	assert.equal(entry(s, "e1").checks, null);
	const failed = events(r.effects, "check.failed");
	assert.equal((failed[0].data as { infra?: boolean }).infra, true);
	// Too early: nothing re-issued.
	assert.equal(of(runEffAt(s, { type: "sweep" }, NOW + 1_000).effects, "check").length, 0);
	// After the infra re-check delay the sweep re-issues the check.
	const sw = runEffAt(s, { type: "sweep" }, NOW + INFRA_RECHECK_MS + 1);
	assert.equal(of(sw.effects, "check").length, 1);
	assert.equal(events(sw.effects, "recover").length, 1);
});

test("F2 an infra result on a splice candidate does not fail the entry", () => {
	let s = retiringOne();
	s = run(s, { type: "retire.checked", entryId: "e1", candidate: "cand1", result: infra("cand1") });
	assert.equal(entry(s, "e1").status, "ready");
	assert.equal(s._internal.retiring["e1"], true);
});

// --- F3: a failed effect never wedges the component ----------------------------

test("F3 fork.failed keeps the entry pending and the sweep re-issues it after backoff", () => {
	let s = trunked();
	s = run(s, { type: "entry.create", agent: "api", lane: "api" });
	const r = runEffAt(s, { type: "fork.failed", entryId: "e1", planned: "arb-e1-api-0", reason: "artifacts 500" });
	s = r.state;
	assert.equal(s._internal.pending["e1"], "arb-e1-api-0");
	assert.equal(events(r.effects, "recover").length, 1);
	assert.equal(forks(runEffAt(s, { type: "sweep" }, NOW + FORK_RETRY_BASE_MS - 1).effects).length, 0);
	const sw = runEffAt(s, { type: "sweep" }, NOW + FORK_RETRY_BASE_MS);
	const f = forks(sw.effects);
	assert.equal(f.length, 1);
	assert.deepEqual([f[0].fromRepo, f[0].toRepo], ["arb-trunk", "arb-e1-api-0"]);
	// A second failure doubles the backoff.
	s = run(sw.state, { type: "fork.failed", entryId: "e1", planned: "arb-e1-api-0", reason: "again" }, NOW + FORK_RETRY_BASE_MS);
	assert.equal(s._internal.forkRetryAt["e1"], NOW + FORK_RETRY_BASE_MS + 2 * FORK_RETRY_BASE_MS);
});

test("F3 sweep re-issues a stale in-flight fork from its original source", () => {
	let s = producerConsumer();
	// Producer breaking push: e2 squashed, refork from e1 in flight.
	s = run(s, { type: "push", repo: "arb-e1-api-0", commit: "p2", exports: { createOrder: "h2" }, sigs: { createOrder: "sig2" } });
	assert.equal(s._internal.pending["e2"], "arb-e2-ui-1");
	assert.equal(forks(runEffAt(s, { type: "sweep" }, NOW + STALE_MARKER_MS).effects).length, 0);
	const sw = runEffAt(s, { type: "sweep" }, NOW + STALE_MARKER_MS + 1);
	const f = forks(sw.effects);
	assert.equal(f.length, 1);
	assert.deepEqual([f[0].fromRepo, f[0].toRepo], ["arb-e1-api-0", "arb-e2-ui-1"]);
	assert.equal((events(sw.effects, "recover")[0].data as { kind: string }).kind, "refork");
});

test("F3 sweep clears a stale retiring marker and the cascade re-issues the retire", () => {
	const s = retiringOne();
	assert.equal(of(runEffAt(s, { type: "sweep" }, NOW + 1_000).effects, "retire").length, 0);
	const sw = runEffAt(s, { type: "sweep" }, NOW + STALE_MARKER_MS + 1);
	assert.equal(of(sw.effects, "retire").length, 1);
	assert.equal((events(sw.effects, "recover")[0].data as { kind: string }).kind, "reretire");
});

test("F3 effect.failed narrates a recover event without touching state", () => {
	const s = producerConsumer();
	const before = JSON.stringify(s.entries);
	const r = runEffAt(s, { type: "effect.failed", entryId: "e2", effect: "token", reason: "rate limited" });
	assert.equal(JSON.stringify(r.state.entries), before);
	assert.deepEqual(events(r.effects, "recover")[0].data, { kind: "token-failed", reason: "rate limited" });
});

// --- F4: producer push during the consumer's in-flight fork -------------------

test("F4 producer push during the consumer's in-flight refork squashes again on fork.done", () => {
	let s = producerConsumer();
	// Breaking push p2: e2 squashed, refork (captures p2 content) in flight.
	s = run(s, { type: "push", repo: "arb-e1-api-0", commit: "p2", exports: { createOrder: "h2" }, sigs: { createOrder: "sig2" } });
	assert.equal(entry(s, "e2").generation, 1);
	// Second breaking push p3 BEFORE the refork lands: pending dedupe, no fork.
	const mid = runEffAt(s, { type: "push", repo: "arb-e1-api-0", commit: "p3", exports: { createOrder: "h3" }, sigs: { createOrder: "sig3" } });
	s = mid.state;
	assert.equal(forks(mid.effects).length, 0);
	// The refork lands carrying p2 content: it is already stale.
	const r = runEffAt(s, {
		type: "fork.done", entryId: "e2", repo: "arb-e2-ui-1", remote: "https://x/e2g1",
		baseCommit: "p2", exports: { createOrder: "h2" }, sigs: { createOrder: "sig2" }, planned: "arb-e2-ui-1",
	});
	s = r.state;
	const e2 = entry(s, "e2");
	assert.equal(e2.status, "squashed");
	assert.equal(e2.generation, 2);
	assert.equal(e2.diagnosis?.changed[0].newHash, "h3");
	const f = forks(r.effects);
	assert.equal(f.length, 1);
	assert.deepEqual([f[0].fromRepo, f[0].toRepo], ["arb-e1-api-0", "arb-e2-ui-2"]);
	assert.equal(of(r.effects, "token").length, 0, "no token for a fork that is already stale");
	// The next fork carries p3: consumes now match, token handed out.
	const r2 = runEffAt(s, {
		type: "fork.done", entryId: "e2", repo: "arb-e2-ui-2", remote: "https://x/e2g2",
		baseCommit: "p3", exports: { createOrder: "h3" }, planned: "arb-e2-ui-2",
	});
	assert.equal(entry(r2.state, "e2").consumes.createOrder, "h3");
	assert.equal(of(r2.effects, "token").length, 1);
	assert.equal(entry(r2.state, "e2").generation, 2);
});

test("F4 fork.done from the producer's current head never re-squashes", () => {
	let s = producerConsumer();
	s = run(s, { type: "push", repo: "arb-e1-api-0", commit: "p2", exports: { createOrder: "h2" } });
	const r = runEffAt(s, {
		type: "fork.done", entryId: "e2", repo: "arb-e2-ui-1", remote: "https://x/e2g1",
		baseCommit: "p2", exports: { createOrder: "h2" }, planned: "arb-e2-ui-1",
	});
	assert.equal(forks(r.effects).length, 0);
	assert.equal(of(r.effects, "token").length, 1);
	assert.equal(entry(r.state, "e2").generation, 1);
});

test("F4 a superseded fork.done (planned name no longer pending) is dropped", () => {
	let s = producerConsumer();
	s = run(s, { type: "push", repo: "arb-e1-api-0", commit: "p2", exports: { createOrder: "h2" } });
	const r = runEffAt(s, {
		type: "fork.done", entryId: "e2", repo: "arb-e2-ui-0-old", remote: "https://x/old",
		baseCommit: "p1", exports: { createOrder: "h1" }, planned: "arb-e2-ui-0",
	});
	assert.equal(entry(r.state, "e2").repo, "arb-e2-ui-0");
	assert.equal(r.state._internal.pending["e2"], "arb-e2-ui-1");
	assert.equal(of(r.effects, "token").length, 0);
});

// --- F5: veto during an in-flight retire --------------------------------------

test("F5 veto while a retire cycle is in flight is rejected with 409", () => {
	const s = retiringOne();
	const r = apply(s, { type: "entry.veto", entryId: "e1" }, NOW);
	assert.equal(r.ok, false);
	assert.equal((r as { status: number }).status, 409);
	assert.equal(entry(s, "e1").status, "ready");
});

test("F5 a stale retire.overlap (entry no longer retiring) does not squash", () => {
	let s = retiringOne();
	s = run(s, { type: "push", repo: "arb-e1-api-0", commit: "c2", exports: {} });
	const r = runEffAt(s, { type: "retire.overlap", entryId: "e1", overlap: ["a.ts"] });
	assert.equal(entry(r.state, "e1").status, "speculating");
	assert.equal(entry(r.state, "e1").generation, 0);
	assert.equal(forks(r.effects).length, 0);
});

// --- F6: push during retire keeps trunk and buffer in sync ---------------------

test("F6 a stale retire.done still advances trunk and the entry base", () => {
	let s = retiringOne();
	s = run(s, { type: "push", repo: "arb-e1-api-0", commit: "c2", exports: {} });
	const r = runEffAt(s, { type: "retire.done", entryId: "e1", commit: "cand1", entryCommit: "c1", mode: "splice" });
	s = r.state;
	assert.equal(entry(s, "e1").status, "speculating");
	assert.equal(entry(s, "e1").baseCommit, "c1");
	assert.equal(s.trunk.commit, "cand1");
	assert.equal(s.trunk.retiredCount, 0);
	assert.equal(events(r.effects, "retired").length, 0);
});

// --- F11: low-priority items ----------------------------------------------------

test("F11 vetoing a stubbed producer releases its consumers' prediction pins", () => {
	let s = trunked();
	s = run(s, {
		type: "entry.create", agent: "api", lane: "api",
		stub: { exports: { createOrder: "hP" }, sigs: { createOrder: "sigP" } },
	});
	s = run(s, { type: "fork.done", entryId: "e1", repo: "arb-e1-api-0", remote: "https://x/e1", baseCommit: "t0", exports: { createOrder: "hT" } });
	s = run(s, { type: "entry.create", agent: "ui", lane: "ui", producerId: "e1", consumes: ["createOrder"] });
	assert.deepEqual(s._internal.predConsumed["e2"], ["createOrder"]);
	s = run(s, { type: "entry.veto", entryId: "e1" });
	assert.equal(s._internal.predConsumed["e2"], undefined);
});

test("F11 cascaded squash diagnoses a grandchild against its direct producer", () => {
	let s = trunked();
	s = run(s, { type: "entry.create", agent: "api", lane: "api" });
	s = run(s, { type: "fork.done", entryId: "e1", repo: "arb-e1-api-0", remote: "https://x/e1", baseCommit: "p1", exports: { createOrder: "h1" } });
	// e2 declares a stubbed helper that its own consumer e3 forwards against.
	s = run(s, {
		type: "entry.create", agent: "mid", lane: "mid", producerId: "e1", consumes: ["createOrder"],
		stub: { exports: { midHelper: "hM" }, sigs: { midHelper: "sigM" } },
	});
	s = run(s, { type: "fork.done", entryId: "e2", repo: "arb-e2-mid-0", remote: "https://x/e2", baseCommit: "p1", exports: { createOrder: "h1" } });
	s = run(s, { type: "entry.create", agent: "ui", lane: "ui", producerId: "e2", consumes: ["midHelper"] });
	s = run(s, { type: "fork.done", entryId: "e3", repo: "arb-e3-ui-0", remote: "https://x/e3", baseCommit: "p1", exports: { createOrder: "h1" } });
	// Root breaking change squashes e2, which cascades onto e3.
	s = run(s, { type: "push", repo: "arb-e1-api-0", commit: "p2", exports: { createOrder: "h2" } });
	const d = entry(s, "e3").diagnosis!;
	assert.equal(d.reason, "producer-squashed");
	// e2 still declares midHelper=hM, so e3's consumed symbol did not move.
	assert.deepEqual(d.changed, []);
});
