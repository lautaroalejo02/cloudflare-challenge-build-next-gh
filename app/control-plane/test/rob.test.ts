import { test } from "node:test";
import assert from "node:assert/strict";
import {
	apply,
	initialState,
	type ApplyResult,
	type Cmd,
	type Effect,
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
	return ok(apply(state, cmd, NOW));
}

function runEff(state: RobState, cmd: Cmd): { state: RobState; effects: Effect[] } {
	const r = apply(state, cmd, NOW);
	return { state: ok(r), effects: eff(r) };
}

function forkEffects(effects: Effect[]): Array<Extract<Effect, { type: "fork" }>> {
	return effects.filter((e): e is Extract<Effect, { type: "fork" }> => e.type === "fork");
}

function broadcasts(effects: Effect[], type?: string) {
	return effects
		.filter((e): e is Extract<Effect, { type: "broadcast" }> => e.type === "broadcast")
		.map((e) => e.event)
		.filter((ev) => !type || ev.type === type);
}

function entry(state: RobState, id: string) {
	const e = state.entries.find((x) => x.id === id);
	assert.ok(e, `entry ${id} missing`);
	return e!;
}

/** State with an initialized trunk at commit "t0". */
function trunked(commit = "t0"): RobState {
	let s = initialState();
	s = run(s, { type: "trunk.init", repo: "arb-trunk", remote: "https://x/arb-trunk", commit });
	return s;
}

/** Create an entry and complete its fork. Returns final state. */
function created(
	state: RobState,
	opts: {
		agent: string;
		lane: string;
		producerId?: string;
		consumes?: string[];
		stub?: { exports: Record<string, string>; sigs: Record<string, string> };
	},
	base: { commit: string; exports?: Record<string, string>; sigs?: Record<string, string> },
): { state: RobState; id: string } {
	const seq = state.entries.length + 1;
	const id = `e${seq}`;
	let r = runEff(state, { type: "entry.create", ...opts });
	assert.ok(forkEffects(r.effects).length === 1, "expected fork effect");
	r = runEff(r.state, {
		type: "fork.done",
		entryId: id,
		repo: r.effects.find((e) => e.type === "fork")!.toRepo,
		remote: `https://x/${id}`,
		baseCommit: base.commit,
		exports: base.exports ?? {},
		sigs: base.sigs ?? {},
	});
	return { state: r.state, id };
}

// ---------------------------------------------------------------------------

test("forwarding: consumer entry forks the producer's current head", () => {
	let s = trunked();
	const p = created(s, { agent: "api-agent", lane: "api" }, {
		commit: "p1",
		exports: { createOrder: "h1" },
		sigs: { createOrder: "sig1" },
	});
	s = p.state;

	const { state, effects } = runEff(s, {
		type: "entry.create",
		agent: "ui-agent",
		lane: "ui",
		producerId: "e1",
		consumes: ["createOrder"],
	});
	const fe = forkEffects(effects);
	assert.equal(fe.length, 1);
	assert.equal(fe[0].fromRepo, "arb-e1-api-0"); // producer fork, not trunk
	assert.equal(fe[0].toRepo, "arb-e2-ui-0");

	s = run(state, {
		type: "fork.done",
		entryId: "e2",
		repo: "arb-e2-ui-0",
		remote: "https://x/e2",
		baseCommit: "p1",
		exports: { createOrder: "h1" },
	});
	assert.equal(entry(s, "e2").consumes.createOrder, "h1");
	assert.equal(entry(s, "e2").producerId, "e1");
	assert.equal(entry(s, "e2").baseCommit, "p1");
});

test("early cutoff: consumed hash unchanged on producer push -> no squash", () => {
	let s = trunked();
	s = created(s, { agent: "a", lane: "api" }, {
		commit: "p1",
		exports: { createOrder: "h1", helper: "hx" },
	}).state;
	s = created(s, { agent: "u", lane: "ui", producerId: "e1", consumes: ["createOrder"] }, {
		commit: "p1",
		exports: { createOrder: "h1", helper: "hx" },
	}).state;

	// producer pushes body-only change: consumed symbol hash identical
	const { state, effects } = runEff(s, {
		type: "push",
		repo: "arb-e1-api-0",
		commit: "p2",
		exports: { createOrder: "h1", helper: "hy" },
		sigs: { createOrder: "sig1" },
	});
	assert.equal(state.entries.find((e) => e.id === "e2")!.status, "speculating");
	assert.equal(state.stats.earlyCutoffs, 1);
	assert.equal(state.stats.squashes, 0);
	assert.equal(broadcasts(effects, "hash.unchanged").length, 1);
	assert.equal(broadcasts(effects, "squash").length, 0);
	assert.equal(entry(state, "e1").headCommit, "p2");
	assert.equal(entry(state, "e1").exports.helper, "hy");
});

test("squash with diagnosis: consumed symbol changed", () => {
	let s = trunked();
	s = created(s, { agent: "a", lane: "api" }, {
		commit: "p1",
		exports: { createOrder: "h1" },
		sigs: { createOrder: "sig1" },
	}).state;
	s = created(s, { agent: "u", lane: "ui", producerId: "e1", consumes: ["createOrder"] }, {
		commit: "p1",
		exports: { createOrder: "h1" },
		sigs: { createOrder: "sig1" },
	}).state;

	const { state, effects } = runEff(s, {
		type: "push",
		repo: "arb-e1-api-0",
		commit: "p2",
		exports: { createOrder: "h2" },
		sigs: { createOrder: "sig2" },
	});
	const ui = entry(state, "e2");
	assert.equal(ui.status, "squashed");
	assert.equal(ui.generation, 1);
	assert.deepEqual(ui.diagnosis, {
		reason: "interface-changed",
		changed: [{ symbol: "createOrder", oldHash: "h1", newHash: "h2", oldSignature: "sig1", newSignature: "sig2" }],
		producerCommit: "p2",
	});
	assert.equal(state.stats.squashes, 1);
	assert.equal(broadcasts(effects, "hash.changed").length, 1);
	assert.equal(broadcasts(effects, "squash").length, 1);

	const fe = forkEffects(effects);
	assert.equal(fe.length, 1);
	assert.equal(fe[0].entryId, "e2");
	assert.equal(fe[0].fromRepo, "arb-e1-api-0");
	assert.equal(fe[0].toRepo, "arb-e2-ui-1");

	// refork completes: repo pointer and consumes move to the new base
	const s2 = run(state, {
		type: "fork.done",
		entryId: "e2",
		repo: "arb-e2-ui-1",
		remote: "https://x/e2g1",
		baseCommit: "p2",
		exports: { createOrder: "h2" },
	});
	assert.equal(entry(s2, "e2").repo, "arb-e2-ui-1");
	assert.equal(entry(s2, "e2").consumes.createOrder, "h2");
	assert.equal(entry(s2, "e2").baseCommit, "p2");
});

test("transitive squash: dependents of squashed entries squash too", () => {
	let s = trunked();
	s = created(s, { agent: "a", lane: "api" }, {
		commit: "p1",
		exports: { createOrder: "h1" },
		sigs: { createOrder: "sig1" },
	}).state;
	s = created(s, { agent: "u", lane: "ui", producerId: "e1", consumes: ["createOrder"] }, {
		commit: "p1",
		exports: { createOrder: "h1", checkoutPage: "u1" },
	}).state;
	s = created(s, { agent: "t", lane: "tests", producerId: "e2", consumes: ["checkoutPage"] }, {
		commit: "p1",
		exports: { createOrder: "h1", checkoutPage: "u1" },
	}).state;

	const { state, effects } = runEff(s, {
		type: "push",
		repo: "arb-e1-api-0",
		commit: "p2",
		exports: { createOrder: "h2" },
		sigs: { createOrder: "sig2" },
	});
	assert.equal(entry(state, "e2").status, "squashed");
	assert.equal(entry(state, "e2").diagnosis!.reason, "interface-changed");
	assert.equal(entry(state, "e3").status, "squashed");
	assert.equal(entry(state, "e3").diagnosis!.reason, "producer-squashed");
	assert.equal(state.stats.squashes, 2);

	// reforks emitted in dependency order: ui first, then tests off ui's new fork
	const fe = forkEffects(effects);
	assert.deepEqual(fe.map((f) => f.entryId), ["e2", "e3"]);
	assert.equal(fe[0].toRepo, "arb-e2-ui-1");
	assert.equal(fe[1].fromRepo, "arb-e2-ui-1");
	assert.equal(fe[1].toRepo, "arb-e3-tests-1");
});

test("in-order retirement: head only, producer retired, ready, checks passed", () => {
	let s = trunked();
	s = created(s, { agent: "a", lane: "api" }, { commit: "p1" }).state;
	s = created(s, { agent: "u", lane: "ui", producerId: "e1" }, { commit: "p1" }).state;

	// ui ready first: NOT head -> no check started
	{
		const { state, effects } = runEff(s, { type: "entry.ready", entryId: "e2", commit: "p1" });
		assert.equal(entry(state, "e2").status, "ready");
		assert.equal(effects.filter((e) => e.type === "check").length, 0);
		s = state;
	}
	// api ready -> head -> check starts
	{
		const { state, effects } = runEff(s, { type: "entry.ready", entryId: "e1", commit: "p1" });
		assert.equal(entry(state, "e1").status, "checking");
		const ce = effects.filter((e) => e.type === "check");
		assert.equal(ce.length, 1);
		assert.equal(ce[0].entryId, "e1");
		s = state;
	}
	// check passes -> retire effect for e1 only
	{
		const { state, effects } = runEff(s, {
			type: "check.done",
			entryId: "e1",
			result: { commit: "p1", passed: 1, failed: 0, durationMs: 5, results: [] },
		});
		const re = effects.filter((e) => e.type === "retire");
		assert.equal(re.length, 1);
		assert.equal(re[0].entryId, "e1");
		assert.equal(re[0].toRepo, "arb-trunk");
		s = state;
	}
	// retire.done -> e1 retired, trunk advanced, now e2 becomes head and checks start
	{
		const { state, effects } = runEff(s, { type: "retire.done", entryId: "e1", commit: "trunk1" });
		assert.equal(entry(state, "e1").status, "retired");
		assert.equal(state.trunk.commit, "trunk1");
		assert.equal(state.trunk.retiredCount, 1);
		assert.equal(state.stats.retired, 1);
		// e2 is head now; it is ready and unchecked -> check starts
		const ce = effects.filter((e) => e.type === "check");
		assert.equal(ce.length, 1);
		assert.equal(ce[0].entryId, "e2");
		s = state;
	}
	// e2 check passes -> retire -> retired
	{
		const { state } = runEff(s, {
			type: "check.done",
			entryId: "e2",
			result: { commit: "p1", passed: 1, failed: 0, durationMs: 5, results: [] },
		});
		s = state;
	}
	s = run(s, { type: "retire.done", entryId: "e2", commit: "trunk2" });
	assert.equal(entry(s, "e2").status, "retired");
	assert.equal(s.trunk.retiredCount, 2);
});

test("failing check blocks retirement; next push retries", () => {
	let s = trunked();
	s = created(s, { agent: "a", lane: "api" }, { commit: "p1" }).state;
	s = run(s, { type: "entry.ready", entryId: "e1", commit: "p1" });
	const r1 = runEff(s, {
		type: "check.done",
		entryId: "e1",
		result: { commit: "p1", passed: 0, failed: 1, durationMs: 5, results: [{ name: "t", ok: false }] },
	});
	s = r1.state;
	assert.equal(entry(s, "e1").status, "failed");
	assert.equal(r1.effects.filter((e) => e.type === "retire").length, 0);
	assert.equal(broadcasts(r1.effects, "check.failed").length, 1);

	// next push -> back to speculating, diagnosis cleared, head updated
	s = run(s, { type: "push", repo: "arb-e1-api-0", commit: "p2", exports: {} });
	assert.equal(entry(s, "e1").status, "speculating");
	assert.equal(entry(s, "e1").headCommit, "p2");

	// ready again -> check retries at the new head
	const r2 = runEff(s, { type: "entry.ready", entryId: "e1", commit: "p2" });
	const ce = r2.effects.filter((e) => e.type === "check");
	assert.equal(ce.length, 1);
	assert.equal(ce[0].commit, "p2");
	s = r2.state;
	s = run(s, {
		type: "check.done",
		entryId: "e1",
		result: { commit: "p2", passed: 1, failed: 0, durationMs: 5, results: [] },
	});
	s = run(s, { type: "retire.done", entryId: "e1", commit: "trunk1" });
	assert.equal(entry(s, "e1").status, "retired");
});

test("robSize admission: 409 when buffer full", () => {
	let s = trunked();
	s = run(s, { type: "config.set", robSize: 1 });
	s = created(s, { agent: "a", lane: "api" }, { commit: "p1" }).state;
	const r = apply(s, { type: "entry.create", agent: "b", lane: "ui" }, NOW);
	assert.equal(r.ok, false);
	assert.equal((r as { status: number }).status, 409);
});

test("veto: head only, squashes transitive dependents", () => {
	let s = trunked();
	s = created(s, { agent: "a", lane: "api" }, {
		commit: "p1",
		exports: { createOrder: "h1" },
	}).state;
	s = created(s, { agent: "u", lane: "ui", producerId: "e1", consumes: ["createOrder"] }, {
		commit: "p1",
		exports: { createOrder: "h1", checkoutPage: "u1" },
	}).state;
	s = created(s, { agent: "t", lane: "tests", producerId: "e2", consumes: ["checkoutPage"] }, {
		commit: "p1",
		exports: { createOrder: "h1", checkoutPage: "u1" },
	}).state;

	// non-head veto rejected
	const bad = apply(s, { type: "entry.veto", entryId: "e2" }, NOW);
	assert.equal(bad.ok, false);
	assert.equal((bad as { status: number }).status, 409);

	const { state, effects } = runEff(s, { type: "entry.veto", entryId: "e1" });
	assert.equal(entry(state, "e1").status, "vetoed");
	assert.equal(entry(state, "e2").status, "squashed");
	assert.equal(entry(state, "e2").diagnosis!.reason, "producer-vetoed");
	// reparented to the vetoed entry's producer (here: trunk)
	assert.equal(entry(state, "e2").producerId, null);
	assert.equal(entry(state, "e3").status, "squashed");
	assert.equal(entry(state, "e3").diagnosis!.reason, "producer-squashed");

	const fe = forkEffects(effects);
	assert.deepEqual(fe.map((f) => f.entryId), ["e2", "e3"]);
	assert.equal(fe[0].fromRepo, "arb-trunk"); // vetoed entry's base
	assert.equal(fe[1].fromRepo, "arb-e2-ui-1");
	assert.equal(broadcasts(effects, "veto").length, 1);
});

test("reset clears entries and stats but keeps trunk pointer", () => {
	let s = trunked();
	s = created(s, { agent: "a", lane: "api" }, { commit: "p1" }).state;
	const { state, effects } = runEff(s, { type: "reset" });
	assert.equal(state.entries.length, 0);
	assert.equal(state.stats.squashes, 0);
	assert.equal(state.trunk.commit, "t0");
	assert.equal(broadcasts(effects, "reset").length, 1);
});

test("push dedupe by commit and unknown repo ignored", () => {
	let s = trunked();
	s = created(s, { agent: "a", lane: "api" }, { commit: "p1" }).state;
	s = run(s, { type: "push", repo: "arb-e1-api-0", commit: "p2", exports: {} });
	assert.equal(s.stats.pushesSeen, 1);
	// same commit again -> no-op
	const r = runEff(s, { type: "push", repo: "arb-e1-api-0", commit: "p2", exports: {} });
	assert.equal(r.state.stats.pushesSeen, 1);
	assert.equal(r.effects.length, 0);
	// unknown repo -> no-op
	const r2 = runEff(r.state, { type: "push", repo: "someone-else", commit: "zz", exports: {} });
	assert.equal(r2.state.stats.pushesSeen, 1);
	// trunk push advances trunk.commit
	s = run(s, { type: "push", repo: "arb-trunk", commit: "t9" });
	assert.equal(s.trunk.commit, "t9");
});

test("stale-repo push to the pending refork name is ignored", () => {
	let s = trunked();
	s = created(s, { agent: "a", lane: "api" }, {
		commit: "p1",
		exports: { createOrder: "h1" },
		sigs: { createOrder: "sig1" },
	}).state;
	s = created(s, { agent: "u", lane: "ui", producerId: "e1", consumes: ["createOrder"] }, {
		commit: "p1",
		exports: { createOrder: "h1" },
	}).state;

	// Producer push squashes e2; its re-fork is in flight under the planned
	// name arb-e2-ui-1. /api/reset does not delete repos, so a stale repo with
	// that exact name may still exist and emit a late push event — it must NOT
	// be adopted as e2's head (observed live: a squashed entry flipping back to
	// speculating on a stale repo's commit).
	const r1 = runEff(s, {
		type: "push", repo: "arb-e1-api-0", commit: "p2",
		exports: { createOrder: "h2" }, sigs: { createOrder: "sig2" },
	});
	s = r1.state;
	assert.equal(entry(s, "e2").status, "squashed");
	assert.equal(s._internal.pending["e2"], "arb-e2-ui-1");

	const pushesBefore = s.stats.pushesSeen;
	const r2 = runEff(s, {
		type: "push", repo: "arb-e2-ui-1", commit: "STALE",
		exports: { createOrder: "hz" }, sigs: { createOrder: "sigz" },
	});
	s = r2.state;
	assert.equal(entry(s, "e2").headCommit, "p1"); // not the stale commit
	assert.equal(entry(s, "e2").status, "squashed");
	assert.equal(s.stats.pushesSeen, pushesBefore);

	// The real re-fork lands under a collision suffix; pushes to the actual
	// repo work, pushes to the stale name stay ignored.
	s = run(s, {
		type: "fork.done", entryId: "e2", repo: "arb-e2-ui-1-x1",
		remote: "https://x/e2g1", baseCommit: "p2", exports: { createOrder: "h2" },
	});
	s = run(s, { type: "push", repo: "arb-e2-ui-1", commit: "STALE2", exports: {} });
	assert.equal(entry(s, "e2").headCommit, "p2");
	s = run(s, { type: "push", repo: "arb-e2-ui-1-x1", commit: "q1", exports: { createOrder: "h2" } });
	assert.equal(entry(s, "e2").headCommit, "q1");
	assert.equal(entry(s, "e2").status, "speculating");
});

test("squash pending dedupe: second producer push updates diagnosis, no double fork", () => {
	let s = trunked();
	s = created(s, { agent: "a", lane: "api" }, {
		commit: "p1",
		exports: { createOrder: "h1" },
		sigs: { createOrder: "sig1" },
	}).state;
	s = created(s, { agent: "u", lane: "ui", producerId: "e1", consumes: ["createOrder"] }, {
		commit: "p1",
		exports: { createOrder: "h1" },
	}).state;

	let r = runEff(s, {
		type: "push", repo: "arb-e1-api-0", commit: "p2",
		exports: { createOrder: "h2" }, sigs: { createOrder: "sig2" },
	});
	s = r.state;
	assert.equal(forkEffects(r.effects).length, 1);

	// producer pushes AGAIN before the consumer's refork landed
	r = runEff(s, {
		type: "push", repo: "arb-e1-api-0", commit: "p3",
		exports: { createOrder: "h3" }, sigs: { createOrder: "sig3" },
	});
	s = r.state;
	assert.equal(forkEffects(r.effects).length, 0); // refork already in flight
	const d = entry(s, "e2").diagnosis!;
	assert.equal(d.producerCommit, "p3");
	assert.equal(d.changed[0].newHash, "h3");
});

/** Drive a single entry through push -> ready -> check pass -> retire effect. */
function retiring(state: RobState, id: string, commit: string): { state: RobState; effects: Effect[] } {
	const e = entry(state, id);
	let s = run(state, { type: "push", repo: e.repo, commit, exports: {} });
	s = run(s, { type: "entry.ready", entryId: id, commit });
	const r = runEff(s, {
		type: "check.done",
		entryId: id,
		result: { commit, passed: 1, failed: 0, durationMs: 5, results: [] },
	});
	return { state: r.state, effects: r.effects };
}

test("atomic splice: checked -> retire.done lands the candidate", () => {
	let s = trunked("t0");
	s = created(s, { agent: "a", lane: "api" }, { commit: "t0" }).state;
	const r = retiring(s, "e1", "c1");
	s = r.state;
	const re = r.effects.filter((e) => e.type === "retire");
	assert.equal(re.length, 1);
	assert.equal(re[0].baseCommit, "t0");

	// ArbTrunk ran the candidate check inside the atomic slot; the component
	// replays it as splice check events, then lands via retire.done.
	const r2 = runEff(s, {
		type: "retire.checked",
		entryId: "e1",
		candidate: "cand1",
		result: { commit: "cand1", passed: 2, failed: 0, durationMs: 7, results: [] },
	});
	s = r2.state;
	const evs = broadcasts(r2.effects);
	assert.equal(evs[0].type, "check.started");
	assert.equal((evs[0].data as { splice?: boolean }).splice, true);
	assert.equal(evs[1].type, "check.passed");
	assert.equal((evs[1].data as { splice?: boolean }).splice, true);
	assert.equal(entry(s, "e1").status, "ready"); // still retiring, not retired yet

	s = run(s, { type: "retire.done", entryId: "e1", commit: "cand1", entryCommit: "c1", mode: "splice" });
	assert.equal(entry(s, "e1").status, "retired");
	assert.equal(s.trunk.commit, "cand1");
	const retiredEv = s._internal.eventLog.find((ev) => ev.type === "retired")!;
	assert.equal((retiredEv.data as { mode: string }).mode, "splice");
});

test("atomic splice: failed candidate check -> failed, retiring cleared", () => {
	let s = trunked("t0");
	s = created(s, { agent: "a", lane: "api" }, { commit: "t0" }).state;
	s = retiring(s, "e1", "c1").state;
	const { state, effects } = runEff(s, {
		type: "retire.checked",
		entryId: "e1",
		candidate: "cand1",
		result: { commit: "cand1", passed: 0, failed: 1, durationMs: 7, results: [{ name: "t", ok: false }] },
	});
	s = state;
	assert.equal(entry(s, "e1").status, "failed");
	assert.equal(s._internal.retiring["e1"], undefined);
	assert.equal(s._internal.retireStart["e1"], undefined);
	assert.equal(broadcasts(effects, "check.failed").length, 1);
	// No re-fire: a failed check is a verdict, not a race.
	assert.equal(effects.filter((e) => e.type === "retire").length, 0);

	// A new push clears the failed state and allows a later re-retire.
	s = run(s, { type: "push", repo: "arb-e1-api-0", commit: "c2", exports: {} });
	assert.equal(entry(s, "e1").status, "speculating");
});

test("retire.retry: narrates a rebuild, keeps retiring, does not re-fire", () => {
	let s = trunked("t0");
	s = created(s, { agent: "a", lane: "api" }, { commit: "t0" }).state;
	s = retiring(s, "e1", "c1").state;
	const { state, effects } = runEff(s, { type: "retire.retry", entryId: "e1", attempt: 1, reason: "non-fast-forward" });
	s = state;
	assert.equal(s._internal.retiring["e1"], true);
	const evs = broadcasts(effects, "retire.retry");
	assert.equal(evs.length, 1);
	assert.deepEqual(evs[0].data, { attempt: 1, reason: "non-fast-forward" });
	assert.equal(effects.filter((e) => e.type === "retire").length, 0);
	// The eventual land still retires normally.
	s = run(s, { type: "retire.done", entryId: "e1", commit: "cand2", entryCommit: "c1", mode: "splice" });
	assert.equal(entry(s, "e1").status, "retired");
});

test("retire.failed: clears retiring, auto-retries below the bound", () => {
	let s = trunked("t0");
	s = created(s, { agent: "a", lane: "api" }, { commit: "t0" }).state;
	s = retiring(s, "e1", "c1").state;
	// First exhausted cycle: retiring cleared, strike 1, cascade re-fires.
	const r1 = runEff(s, { type: "retire.failed", entryId: "e1", reason: "non-fast-forward" });
	s = r1.state;
	assert.equal(s._internal.retireStrikes["e1"], 1);
	assert.equal(broadcasts(r1.effects, "retire.failed").length, 1);
	const re1 = r1.effects.filter((e) => e.type === "retire");
	assert.equal(re1.length, 1); // next cascade retried automatically
	assert.equal(s._internal.retiring["e1"], true);
	// Second exhausted cycle: strike 2, still auto-retrying.
	const r2 = runEff(s, { type: "retire.failed", entryId: "e1", reason: "non-fast-forward" });
	s = r2.state;
	assert.equal(s._internal.retireStrikes["e1"], 2);
	assert.equal(r2.effects.filter((e) => e.type === "retire").length, 1);
	// Third: bound reached — parked at failed, no further retire effect.
	const r3 = runEff(s, { type: "retire.failed", entryId: "e1", reason: "non-fast-forward" });
	s = r3.state;
	assert.equal(s._internal.retireStrikes["e1"], 3);
	assert.equal(entry(s, "e1").status, "failed");
	assert.equal(r3.effects.filter((e) => e.type === "retire").length, 0);
	const last = broadcasts(r3.effects, "retire.failed").at(-1)!;
	assert.equal((last.data as { exhausted: boolean }).exhausted, true);
});

test("retire.failed: a push or re-ready resets strikes and re-arms retirement", () => {
	const failedAtBound = (): RobState => {
		let s = trunked("t0");
		s = created(s, { agent: "a", lane: "api" }, { commit: "t0" }).state;
		s = retiring(s, "e1", "c1").state;
		for (let i = 0; i < 3; i++) {
			s = run(s, { type: "retire.failed", entryId: "e1", reason: "x" });
		}
		assert.equal(entry(s, "e1").status, "failed");
		return s;
	};

	// Path 1: a new push resets everything.
	let s = failedAtBound();
	s = run(s, { type: "push", repo: "arb-e1-api-0", commit: "c2", exports: {} });
	assert.equal(s._internal.retireStrikes["e1"], undefined);
	s = run(s, { type: "entry.ready", entryId: "e1", commit: "c2" });
	s = run(s, {
		type: "check.done", entryId: "e1",
		result: { commit: "c2", passed: 1, failed: 0, durationMs: 5, results: [] },
	});
	assert.equal(s._internal.retiring["e1"], true);

	// Path 2: a fresh entry.ready on the same failed head also resets.
	s = failedAtBound();
	const r = runEff(s, { type: "entry.ready", entryId: "e1", commit: "c1" });
	assert.equal(r.state._internal.retireStrikes["e1"], undefined);
	assert.equal(r.effects.filter((e) => e.type === "retire").length, 1);
});

test("stale retire.* commands are dropped when the entry is not retiring", () => {
	let s = trunked("t0");
	s = created(s, { agent: "a", lane: "api" }, { commit: "t0" }).state;
	// Never marked ready -> not retiring: every retire.* verdict is stale.
	for (const cmd of [
		{ type: "retire.retry", entryId: "e1", attempt: 1, reason: "x" } as Cmd,
		{ type: "retire.checked", entryId: "e1", candidate: "candX", result: { commit: "candX", passed: 1, failed: 0, durationMs: 1, results: [] } } as Cmd,
		{ type: "retire.failed", entryId: "e1", reason: "x" } as Cmd,
	]) {
		const { state, effects } = runEff(s, cmd);
		s = state;
		assert.equal(effects.filter((e) => e.type === "broadcast").length, 0);
		assert.equal(effects.filter((e) => e.type === "retire").length, 0);
	}
	assert.equal(entry(s, "e1").status, "speculating");
	assert.equal(s._internal.retireStrikes["e1"], undefined);
});

test("mid-atomic push: stale retire.done does not retire but records the landing (T19 F6)", () => {
	let s = trunked("t0");
	s = created(s, { agent: "a", lane: "api" }, { commit: "t0" }).state;
	s = retiring(s, "e1", "c1").state;
	// A push lands while the atomic cycle is in flight: retiring cleared,
	// entry back to speculating at c2.
	s = run(s, { type: "push", repo: "arb-e1-api-0", commit: "c2", exports: {} });
	assert.equal(s._internal.retiring["e1"], undefined);
	// The late-arriving atomic result is stale and must not retire the entry,
	// but its land is real: trunk advances and the entry's base moves to the
	// landed entry commit, so the next retirement diffs only the new work.
	const r = runEff(s, { type: "retire.done", entryId: "e1", commit: "cand1", entryCommit: "c1", mode: "splice" });
	s = r.state;
	assert.equal(entry(s, "e1").status, "speculating");
	assert.equal(entry(s, "e1").baseCommit, "c1");
	assert.equal(s.trunk.commit, "cand1");
	assert.equal(s.trunk.retiredCount, 0);
	assert.equal(broadcasts(r.effects, "retired").length, 0);
});

test("trunk-overlap: retire.overlap squashes the entry with reason", () => {
	let s = trunked("t9");
	s = created(s, { agent: "a", lane: "api" }, { commit: "t0" }).state;
	s = retiring(s, "e1", "c1").state;
	const { state, effects } = runEff(s, { type: "retire.overlap", entryId: "e1", overlap: ["src/api/order.ts"] });
	s = state;
	const e = entry(s, "e1");
	assert.equal(e.status, "squashed");
	assert.equal(e.generation, 1);
	assert.deepEqual(e.diagnosis, { reason: "trunk-overlap", changed: [], producerCommit: "t9" });
	assert.equal(s.stats.squashes, 1);
	const fe = forkEffects(effects);
	assert.equal(fe.length, 1);
	assert.equal(fe[0].fromRepo, "arb-trunk"); // producerId null -> trunk
	assert.equal(fe[0].toRepo, "arb-e1-api-1");
	const sq = broadcasts(effects, "squash");
	assert.equal(sq.length, 1);
	assert.equal((sq[0].data as { reason: string }).reason, "trunk-overlap");
});

test("retire.done: entryCommit staleness ignored when head moved", () => {
	let s = trunked("t0");
	s = created(s, { agent: "a", lane: "api" }, { commit: "t0" }).state;
	s = retiring(s, "e1", "c1").state;
	// a push lands mid-retire: entry goes back to speculating at c2
	s = run(s, { type: "push", repo: "arb-e1-api-0", commit: "c2", exports: {} });
	const r = runEff(s, { type: "retire.done", entryId: "e1", commit: "c1", entryCommit: "c1", mode: "fast-forward" });
	s = r.state;
	assert.equal(entry(s, "e1").status, "speculating"); // not retired
	assert.equal(entry(s, "e1").baseCommit, "c1"); // T19 F6: base advances to the landed commit
	assert.equal(s.trunk.commit, "c1");
	assert.equal(s.trunk.retiredCount, 0);
	assert.equal(broadcasts(r.effects, "retired").length, 0);
});

// --- T11: declared-stub value prediction -------------------------------------

const STUB = {
	exports: { createOrder: "hP", Order: "hO" },
	sigs: { createOrder: "sigP", Order: "sigO" },
};

test("stub: producer exports are predicted at registration and survive the fork", () => {
	let s = trunked();
	let r = runEff(s, { type: "entry.create", agent: "api", lane: "api", stub: STUB });
	s = r.state;
	const e1 = entry(s, "e1");
	assert.deepEqual(e1.exports, { createOrder: "hP", Order: "hO" });
	assert.deepEqual(e1.predicted, ["createOrder", "Order"]);
	const createdEv = broadcasts(r.effects, "entry.created")[0];
	assert.deepEqual((createdEv.data as { predicted: string[] }).predicted, ["createOrder", "Order"]);

	// The fork's actual (base) exports merge in; predicted symbols keep the
	// declared hashes until the producer's first real push resolves them.
	s = run(s, {
		type: "fork.done",
		entryId: "e1",
		repo: "arb-e1-api-0",
		remote: "https://x/e1",
		baseCommit: "p0",
		exports: { createOrder: "hBase", Order: "hBaseO", helper: "hx" },
		sigs: { createOrder: "sigBase", Order: "sigBaseO", helper: "sigx" },
	});
	assert.equal(entry(s, "e1").exports.createOrder, "hP");
	assert.equal(entry(s, "e1").exports.Order, "hO");
	assert.equal(entry(s, "e1").exports.helper, "hx");
	assert.deepEqual(entry(s, "e1").predicted, ["createOrder", "Order"]);
});

test("consumer forwards against predicted hashes before the producer pushes", () => {
	let s = trunked();
	let r = runEff(s, { type: "entry.create", agent: "api", lane: "api", stub: STUB });
	s = r.state;
	// Consumer registers while the producer fork is still in flight: its fork
	// effect targets the producer's planned repo and its consumes pin the
	// predicted hashes immediately (value prediction, not the base content).
	r = runEff(s, {
		type: "entry.create",
		agent: "ui",
		lane: "ui",
		producerId: "e1",
		consumes: ["createOrder", "Order"],
	});
	s = r.state;
	assert.equal(entry(s, "e2").consumes.createOrder, "hP");
	assert.equal(entry(s, "e2").consumes.Order, "hO");
	assert.equal(forkEffects(r.effects)[0].fromRepo, "arb-e1-api-0");

	s = run(s, {
		type: "fork.done",
		entryId: "e1",
		repo: "arb-e1-api-0",
		remote: "https://x/e1",
		baseCommit: "p0",
		exports: { createOrder: "hBase", Order: "hBaseO" },
		sigs: { createOrder: "sigBase", Order: "sigBaseO" },
	});
	// The consumer's fork contains the producer's BASE, but its recorded
	// consumes stay the predicted hashes it forwarded against.
	s = run(s, {
		type: "fork.done",
		entryId: "e2",
		repo: "arb-e2-ui-0",
		remote: "https://x/e2",
		baseCommit: "p0",
		exports: { createOrder: "hBase", Order: "hBaseO" },
		sigs: {},
	});
	assert.equal(entry(s, "e2").consumes.createOrder, "hP");
	assert.equal(entry(s, "e2").consumes.Order, "hO");
});

/** Stubbed e1 (predicted createOrder=hP, Order=hO) with e2 consuming both and
 * e3 consuming createOrder; all forks landed on base commit p0. */
function predictedWorld(): RobState {
	let s = trunked();
	s = created(s, { agent: "api", lane: "api", stub: STUB }, {
		commit: "p0",
		exports: { createOrder: "hBase", Order: "hBaseO" },
		sigs: { createOrder: "sigBase", Order: "sigBaseO" },
	}).state;
	s = created(s, { agent: "ui", lane: "ui", producerId: "e1", consumes: ["createOrder", "Order"] }, {
		commit: "p0",
		exports: { createOrder: "hBase", Order: "hBaseO" },
	}).state;
	s = created(s, { agent: "tests", lane: "tests", producerId: "e1", consumes: ["createOrder"] }, {
		commit: "p0",
		exports: { createOrder: "hBase", Order: "hBaseO" },
	}).state;
	return s;
}

test("first push resolves predictions: per-consumer hit/miss with stats and events", () => {
	const s = predictedWorld();
	// First real push: createOrder landed as declared (hit), Order diverged
	// (miss — a field was added that the stub did not declare).
	const r = runEff(s, {
		type: "push",
		repo: "arb-e1-api-0",
		commit: "p1",
		exports: { createOrder: "hP", Order: "hO2", helper: "hx" },
		sigs: { createOrder: "sigP", Order: "sigO2", helper: "sigx" },
	});
	const evs = (t: string) => broadcasts(r.effects, t);

	// e2 forwarded {createOrder, Order}: hit on createOrder, miss on Order.
	const e2 = entry(r.state, "e2");
	assert.equal(e2.status, "squashed");
	assert.equal(e2.generation, 1);
	assert.deepEqual(e2.diagnosis, {
		reason: "prediction-miss",
		changed: [
			{ symbol: "Order", oldHash: "hO", newHash: "hO2", oldSignature: "sigO", newSignature: "sigO2" },
		],
		producerCommit: "p1",
	});
	// e3 forwarded {createOrder} only: pure hit, untouched.
	assert.equal(entry(r.state, "e3").status, "speculating");
	assert.equal(entry(r.state, "e3").diagnosis, null);

	assert.equal(r.state.stats.predictionHits, 2);
	assert.equal(r.state.stats.predictionMisses, 1);
	assert.equal(r.state.stats.squashes, 1);
	assert.equal(r.state.stats.earlyCutoffs, 0); // a hit is not a cutoff
	assert.equal(evs("prediction.hit").length, 2);
	assert.equal(evs("prediction.miss").length, 1);
	const miss = evs("prediction.miss")[0];
	assert.equal(miss.entryId, "e2");
	const squash = evs("squash")[0];
	assert.equal(squash.entryId, "e2");
	assert.equal((squash.data as { reason: string }).reason, "prediction-miss");
	// The producer's predictions are resolved by the first push.
	assert.deepEqual(entry(r.state, "e1").predicted, []);

	// Re-fork lands on the real head: consumes unpin and record the actuals.
	const s2 = run(r.state, {
		type: "fork.done",
		entryId: "e2",
		repo: "arb-e2-ui-1",
		remote: "https://x/e2g1",
		baseCommit: "p1",
		exports: { createOrder: "hP", Order: "hO2" },
	});
	assert.equal(entry(s2, "e2").consumes.Order, "hO2");
});

test("predictions resolve once: later interface changes are ordinary squashes", () => {
	let s = predictedWorld();
	s = run(s, {
		type: "push",
		repo: "arb-e1-api-0",
		commit: "p1",
		exports: { createOrder: "hP", Order: "hO2" },
		sigs: { createOrder: "sigP", Order: "sigO2" },
	});
	// Second push changes createOrder: ordinary interface-changed squash, not
	// a prediction verdict.
	const r = runEff(s, {
		type: "push",
		repo: "arb-e1-api-0",
		commit: "p2",
		exports: { createOrder: "hP2", Order: "hO2" },
		sigs: { createOrder: "sigP2", Order: "sigO2" },
	});
	assert.equal(entry(r.state, "e3").status, "squashed");
	assert.equal(entry(r.state, "e3").diagnosis!.reason, "interface-changed");
	assert.equal(r.state.stats.predictionHits, 2); // p1: e2.createOrder + e3.createOrder; p2: none
	assert.equal(r.state.stats.predictionMisses, 1);
	assert.equal(broadcasts(r.effects, "prediction.miss").length, 0);
	assert.equal(broadcasts(r.effects, "prediction.hit").length, 0);
	// e3 squashes; e2 (mid-refork from its earlier prediction-miss) just gets
	// the hash.changed notice and an updated diagnosis.
	const changed = broadcasts(r.effects, "hash.changed");
	assert.deepEqual(changed.map((e) => e.entryId).sort(), ["e2", "e3"]);
	assert.equal(broadcasts(r.effects, "squash").length, 1);
});

test("consumer registering after resolution forwards actual, not predicted, hashes", () => {
	let s = predictedWorld();
	s = run(s, {
		type: "push",
		repo: "arb-e1-api-0",
		commit: "p1",
		exports: { createOrder: "hP", Order: "hO2" },
	});
	// e4 registers post-resolution: consumes fill from the fork's actuals.
	let r = runEff(s, {
		type: "entry.create",
		agent: "docs",
		lane: "docs",
		producerId: "e1",
		consumes: ["Order"],
	});
	s = r.state;
	assert.equal(entry(s, "e4").consumes.Order, "");
	s = run(s, {
		type: "fork.done",
		entryId: "e4",
		repo: "arb-e4-docs-0",
		remote: "https://x/e4",
		baseCommit: "p1",
		exports: { createOrder: "hP", Order: "hO2" },
	});
	assert.equal(entry(s, "e4").consumes.Order, "hO2");
});

test("non-predicted consumed symbol changing on the first push is an ordinary squash", () => {
	let s = trunked();
	// Stub predicts createOrder only; e2 also consumes unpredicted Order.
	s = created(s, { agent: "api", lane: "api", stub: {
		exports: { createOrder: "hP" },
		sigs: { createOrder: "sigP" },
	} }, {
		commit: "p0",
		exports: { createOrder: "hBase", Order: "hBaseO" },
		sigs: { createOrder: "sigBase", Order: "sigBaseO" },
	}).state;
	s = created(s, { agent: "ui", lane: "ui", producerId: "e1", consumes: ["createOrder", "Order"] }, {
		commit: "p0",
		exports: { createOrder: "hBase", Order: "hBaseO" },
		sigs: { createOrder: "sigBase", Order: "sigBaseO" },
	}).state;

	const r = runEff(s, {
		type: "push",
		repo: "arb-e1-api-0",
		commit: "p1",
		exports: { createOrder: "hP", Order: "hO2" },
		sigs: { createOrder: "sigP", Order: "sigO2" },
	});
	const e2 = entry(r.state, "e2");
	assert.equal(e2.status, "squashed");
	assert.equal(e2.diagnosis!.reason, "interface-changed"); // not a prediction verdict
	assert.equal(r.state.stats.predictionHits, 1);           // createOrder hit
	assert.equal(r.state.stats.predictionMisses, 0);
	assert.equal(broadcasts(r.effects, "prediction.hit").length, 1);
	assert.equal(broadcasts(r.effects, "prediction.miss").length, 0);
	assert.equal(broadcasts(r.effects, "squash").length, 1);
});
