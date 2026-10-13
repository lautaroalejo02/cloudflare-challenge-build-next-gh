// V2 tests for the pure state machine (src/rob.ts): dependency inference
// (consumesInferred + forkedExports), the Jev judge trigger on body-only
// producer pushes, judge.done verdict application (thresholds, staleness,
// cascade), the retirement gate on `judging`, the stale-judgment sweep and
// the new-field defaults / forward-fill.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	apply,
	initialState,
	migrateState,
	STALE_MARKER_MS,
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
function run(state: RobState, cmd: Cmd, now = NOW): RobState {
	return ok(apply(state, cmd, now));
}
function runEff(state: RobState, cmd: Cmd, now = NOW): { state: RobState; effects: Effect[] } {
	const r = apply(state, cmd, now);
	return { state: ok(r), effects: eff(r) };
}
const forks = (effects: Effect[]) => effects.filter((e): e is Extract<Effect, { type: "fork" }> => e.type === "fork");
const judges = (effects: Effect[]) => effects.filter((e): e is Extract<Effect, { type: "judge" }> => e.type === "judge");
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

function trunked(): RobState {
	return run(initialState(), { type: "trunk.init", repo: "arb-trunk", remote: "https://x/arb-trunk", commit: "t0" });
}

/** Producer e1 exporting createOrder=h1, Order=hO (both from src/api/order.ts)
 * and a consumer e2 that registered WITHOUT consumes (consumesInferred). */
function inferredWorld(): RobState {
	let s = trunked();
	s = run(s, { type: "entry.create", agent: "api", lane: "api" });
	s = run(s, {
		type: "fork.done", entryId: "e1", repo: "arb-e1-api-0", remote: "https://x/e1",
		baseCommit: "p1",
		exports: { createOrder: "h1", Order: "hO" },
		sigs: {
			createOrder: { signature: "sig1", file: "src/api/order.ts" },
			Order: { signature: "sigO", file: "src/api/order.ts" },
		},
	});
	s = run(s, { type: "entry.create", agent: "ui", lane: "ui", producerId: "e1" });
	s = run(s, {
		type: "fork.done", entryId: "e2", repo: "arb-e2-ui-0", remote: "https://x/e2",
		baseCommit: "p1",
		exports: { createOrder: "h1", Order: "hO" },
		sigs: {
			createOrder: { signature: "sig1", file: "src/api/order.ts" },
			Order: { signature: "sigO", file: "src/api/order.ts" },
		},
	});
	return s;
}

/** Producer e1 + declared consumer e2 (consumes createOrder=h1). */
function declaredWorld(): RobState {
	let s = trunked();
	s = run(s, { type: "entry.create", agent: "api", lane: "api" });
	s = run(s, {
		type: "fork.done", entryId: "e1", repo: "arb-e1-api-0", remote: "https://x/e1",
		baseCommit: "p1",
		exports: { createOrder: "h1", helper: "hx" },
		sigs: {
			createOrder: { signature: "sig1", file: "src/api/order.ts" },
			helper: { signature: "sigx", file: "src/api/util.ts" },
		},
	});
	s = run(s, { type: "entry.create", agent: "ui", lane: "ui", producerId: "e1", consumes: ["createOrder"] });
	s = run(s, {
		type: "fork.done", entryId: "e2", repo: "arb-e2-ui-0", remote: "https://x/e2",
		baseCommit: "p1",
		exports: { createOrder: "h1", checkoutPage: "u1" },
		sigs: {
			createOrder: { signature: "sig1", file: "src/api/order.ts" },
			checkoutPage: { signature: "sigU", file: "src/ui/checkout.ts" },
		},
	});
	return s;
}

/** declaredWorld + a first producer push that only sets bodies (p2), then a
 * body-only change on createOrder (p3): e2 ends up judging createOrder. */
function judgingWorld(): { s: RobState; judgeEffect: Extract<Effect, { type: "judge" }> } {
	let s = declaredWorld();
	s = run(s, {
		type: "push", repo: "arb-e1-api-0", commit: "p2",
		exports: { createOrder: "h1", helper: "hx" },
		sigs: { createOrder: { signature: "sig1", file: "src/api/order.ts" }, helper: { signature: "sigx", file: "src/api/util.ts" } },
		bodies: { createOrder: "b1", helper: "bx" },
	});
	const r = runEff(s, {
		type: "push", repo: "arb-e1-api-0", commit: "p3",
		exports: { createOrder: "h1", helper: "hx" },
		sigs: { createOrder: { signature: "sig1", file: "src/api/order.ts" }, helper: { signature: "sigx", file: "src/api/util.ts" } },
		bodies: { createOrder: "b2", helper: "bx" },
	});
	s = r.state;
	const judgeEffect = judges(r.effects)[0];
	assert.ok(judgeEffect, "expected a judge effect");
	assert.equal(judgeEffect.consumerId, "e2");
	assert.equal(judgeEffect.producerId, "e1");
	assert.deepEqual(judgeEffect.symbols, ["createOrder"]);
	return { s, judgeEffect };
}

// --- entry.create defaults -------------------------------------------------

test("entry.create: omitted consumes with a producer marks consumesInferred", () => {
	let s = trunked();
	s = run(s, { type: "entry.create", agent: "api", lane: "api" });
	s = run(s, { type: "fork.done", entryId: "e1", repo: "arb-e1-api-0", remote: "x", baseCommit: "p1", exports: { createOrder: "h1" } });
	const e1 = entry(s, "e1");
	assert.equal(e1.consumesInferred, false); // trunk-forked root: no producer to infer from
	assert.deepEqual(e1.judging, []);
	assert.deepEqual(e1.bodies, {});
	assert.deepEqual(e1.forkedExports, { createOrder: "h1" });

	s = run(s, { type: "entry.create", agent: "ui", lane: "ui", producerId: "e1" });
	const e2 = entry(s, "e2");
	assert.equal(e2.consumesInferred, true);
	assert.deepEqual(e2.consumes, {});

	// Explicit consumes (even empty) is a declaration, not inference.
	s = run(s, { type: "entry.create", agent: "t", lane: "tests", producerId: "e1", consumes: [] });
	assert.equal(entry(s, "e3").consumesInferred, false);
});

test("fork.done: forkedExports snapshots fork content including trunk inheritance", () => {
	const s = inferredWorld();
	assert.deepEqual(entry(s, "e2").forkedExports, { createOrder: "h1", Order: "hO" });
	assert.deepEqual(entry(s, "e1").forkedExports, { createOrder: "h1", Order: "hO" });
});

// --- inference --------------------------------------------------------------

test("inference: a named import fills consumes with the forked hash and emits deps.inferred", () => {
	const s = inferredWorld();
	const r = runEff(s, {
		type: "push", repo: "arb-e2-ui-0", commit: "u1",
		imports: [{ file: "src/ui/checkout.ts", from: "src/api/order.ts", names: ["createOrder"] }],
		exports: { createOrder: "h1", Order: "hO", checkoutPage: "u1" },
		sigs: { createOrder: { signature: "sig1", file: "src/api/order.ts" }, checkoutPage: { signature: "sigU", file: "src/ui/checkout.ts" } },
	});
	assert.equal(entry(r.state, "e2").consumes.createOrder, "h1");
	assert.equal(r.state.stats.inferredDeps, 1);
	const ev = events(r.effects, "deps.inferred")[0];
	assert.equal(ev.entryId, "e2");
	assert.deepEqual(ev.data, { producerId: "e1", symbols: { createOrder: "h1" } });
});

test("inference: '*' expands to all of the producer's exports from that file", () => {
	const s = inferredWorld();
	const r = runEff(s, {
		type: "push", repo: "arb-e2-ui-0", commit: "u1",
		imports: [{ file: "src/ui/checkout.ts", from: "src/api/order.ts", names: ["*"] }],
		exports: {},
	});
	const e2 = entry(r.state, "e2");
	assert.equal(e2.consumes.createOrder, "h1");
	assert.equal(e2.consumes.Order, "hO");
	assert.equal(r.state.stats.inferredDeps, 2);
	assert.deepEqual((events(r.effects, "deps.inferred")[0].data as { symbols: Record<string, string> }).symbols, {
		createOrder: "h1",
		Order: "hO",
	});
});

test("inference: an imported name the producer does not export is ignored", () => {
	const s = inferredWorld();
	const r = runEff(s, {
		type: "push", repo: "arb-e2-ui-0", commit: "u1",
		imports: [{ file: "src/ui/checkout.ts", from: "src/api/order.ts", names: ["createOrder", "notExported"] }],
		exports: {},
	});
	const e2 = entry(r.state, "e2");
	assert.equal(e2.consumes.createOrder, "h1");
	assert.equal(e2.consumes.notExported, undefined);
	assert.equal(r.state.stats.inferredDeps, 1);
});

test("inference: deps.inferred only fires for newly inferred names", () => {
	let s = inferredWorld();
	s = run(s, {
		type: "push", repo: "arb-e2-ui-0", commit: "u1",
		imports: [{ file: "src/ui/checkout.ts", from: "src/api/order.ts", names: ["createOrder"] }],
		exports: {},
	});
	const r = runEff(s, {
		type: "push", repo: "arb-e2-ui-0", commit: "u2",
		imports: [
			{ file: "src/ui/checkout.ts", from: "src/api/order.ts", names: ["createOrder"] },
			{ file: "src/ui/other.ts", from: "src/api/order.ts", names: ["Order"] },
		],
		exports: {},
	});
	assert.equal(events(r.effects, "deps.inferred").length, 1);
	assert.deepEqual((events(r.effects, "deps.inferred")[0].data as { symbols: Record<string, string> }).symbols, { Order: "hO" });
	assert.equal(r.state.stats.inferredDeps, 2);
});

test("inference: a newly inferred name that drifted from the producer squashes immediately", () => {
	let s = inferredWorld();
	// Producer pushes an interface change; e2's consumes is still {} so the
	// ordinary diff is a no-op (early cutoff).
	s = run(s, {
		type: "push", repo: "arb-e1-api-0", commit: "p2",
		exports: { createOrder: "h9", Order: "hO" },
		sigs: { createOrder: { signature: "sig9", file: "src/api/order.ts" }, Order: { signature: "sigO", file: "src/api/order.ts" } },
	});
	assert.equal(entry(s, "e2").status, "speculating");
	// e2 now pushes work importing the drifted symbol: it forked against h1.
	const r = runEff(s, {
		type: "push", repo: "arb-e2-ui-0", commit: "u1",
		imports: [{ file: "src/ui/checkout.ts", from: "src/api/order.ts", names: ["createOrder"] }],
		exports: {},
		sigs: { createOrder: { signature: "sig1", file: "src/api/order.ts" } },
	});
	const e2 = entry(r.state, "e2");
	assert.equal(e2.status, "squashed");
	assert.equal(e2.diagnosis?.reason, "interface-changed");
	assert.deepEqual(e2.diagnosis?.changed, [
		{ symbol: "createOrder", oldHash: "h1", newHash: "h9", oldSignature: "sig1", newSignature: "sig9" },
	]);
	assert.equal(e2.diagnosis?.producerCommit, "p2");
	assert.equal(r.state.stats.squashes, 1);
	const fe = forks(r.effects);
	assert.equal(fe.length, 1);
	assert.equal(fe[0].fromRepo, "arb-e1-api-0");
	assert.equal(events(r.effects, "deps.inferred").length, 1);
});

test("deps.undeclared: imports of another live entry's own files are reported once", () => {
	let s = trunked();
	// e1 api owns src/api/order.ts; e3 sibling owns src/svc/pay.ts.
	s = run(s, { type: "entry.create", agent: "api", lane: "api" });
	s = run(s, {
		type: "fork.done", entryId: "e1", repo: "arb-e1-api-0", remote: "x", baseCommit: "p1",
		exports: { createOrder: "h1" },
		sigs: { createOrder: { signature: "sig1", file: "src/api/order.ts" } },
	});
	s = run(s, { type: "entry.create", agent: "ui", lane: "ui", producerId: "e1" });
	s = run(s, {
		type: "fork.done", entryId: "e2", repo: "arb-e2-ui-0", remote: "x", baseCommit: "p1",
		exports: { createOrder: "h1" },
		sigs: { createOrder: { signature: "sig1", file: "src/api/order.ts" } },
	});
	s = run(s, { type: "entry.create", agent: "pay", lane: "pay", producerId: "e2" });
	s = run(s, {
		type: "fork.done", entryId: "e3", repo: "arb-e3-pay-0", remote: "x", baseCommit: "p1",
		exports: { createOrder: "h1", charge: "h3" },
		sigs: {
			createOrder: { signature: "sig1", file: "src/api/order.ts" },
			charge: { signature: "sig3", file: "src/svc/pay.ts" },
		},
	});
	// e3 must actually change its own file, not merely inherit it from trunk.
	s = run(s, { type: "push", repo: "arb-e3-pay-0", commit: "pay1", exports: { createOrder: "h1", charge: "changed" } });
	// e2 pushes work importing e3's own file (a lateral, undeclared dep).
	const r = runEff(s, {
		type: "push", repo: "arb-e2-ui-0", commit: "u1",
		imports: [{ file: "src/ui/checkout.ts", from: "src/svc/pay.ts", names: ["charge"] }],
		exports: {},
	});
	const evs = events(r.effects, "deps.undeclared");
	assert.equal(evs.length, 1);
	assert.equal(evs[0].entryId, "e2");
	assert.deepEqual(evs[0].data, { fromEntryId: "e3", paths: ["src/svc/pay.ts"], symbols: ["charge"] });
	// Reported once: a second push re-importing the same file does not re-emit.
	const r2 = runEff(r.state, {
		type: "push", repo: "arb-e2-ui-0", commit: "u2",
		imports: [{ file: "src/ui/checkout.ts", from: "src/svc/pay.ts", names: ["charge"] }],
		exports: {},
	});
	assert.equal(events(r2.effects, "deps.undeclared").length, 0);
});

// --- judge trigger ----------------------------------------------------------

test("judge trigger: a body-only change on a consumed symbol marks judging and emits one judge effect", () => {
	let s = declaredWorld();
	s = run(s, {
		type: "push", repo: "arb-e1-api-0", commit: "p2",
		exports: { createOrder: "h1", helper: "hx" },
		bodies: { createOrder: "b1", helper: "bx" },
	});
	const r = runEff(s, {
		type: "push", repo: "arb-e1-api-0", commit: "p3",
		exports: { createOrder: "h1", helper: "hx" },
		bodies: { createOrder: "b2", helper: "bx" },
	});
	// Today's early cutoff is preserved.
	assert.equal(r.state.stats.earlyCutoffs, 2);
	assert.equal(events(r.effects, "hash.unchanged").length, 1);
	const e2 = entry(r.state, "e2");
	assert.deepEqual(e2.judging, ["createOrder"]);
	const je = judges(r.effects);
	assert.equal(je.length, 1);
	assert.deepEqual(
		{ consumerId: je[0].consumerId, producerId: je[0].producerId, symbols: je[0].symbols, commit: je[0].commit, generation: je[0].generation },
		{ consumerId: "e2", producerId: "e1", symbols: ["createOrder"], commit: "p3", generation: 0 },
	);
});

test("judge trigger: an interface change squashes as before (no judging)", () => {
	let s = declaredWorld();
	s = run(s, {
		type: "push", repo: "arb-e1-api-0", commit: "p2",
		exports: { createOrder: "h1" },
		bodies: { createOrder: "b1" },
	});
	const r = runEff(s, {
		type: "push", repo: "arb-e1-api-0", commit: "p3",
		exports: { createOrder: "h2" },
		sigs: { createOrder: { signature: "sig2", file: "src/api/order.ts" } },
		bodies: { createOrder: "b2" },
	});
	const e2 = entry(r.state, "e2");
	assert.equal(e2.status, "squashed");
	assert.equal(e2.diagnosis?.reason, "interface-changed");
	assert.deepEqual(e2.judging, []);
	assert.equal(judges(r.effects).length, 0);
});

test("judge trigger: a body-only change on a non-consumed symbol does not judge", () => {
	let s = declaredWorld();
	s = run(s, {
		type: "push", repo: "arb-e1-api-0", commit: "p2",
		exports: { createOrder: "h1", helper: "hx" },
		bodies: { createOrder: "b1", helper: "bx" },
	});
	const r = runEff(s, {
		type: "push", repo: "arb-e1-api-0", commit: "p3",
		exports: { createOrder: "h1", helper: "hx" },
		bodies: { createOrder: "b1", helper: "bx2" },
	});
	assert.deepEqual(entry(r.state, "e2").judging, []);
	assert.equal(judges(r.effects).length, 0);
	assert.equal(r.state.stats.earlyCutoffs, 2);
});

// --- judge.done --------------------------------------------------------------

test("judge.done: p >= 0.7 squashes with behavior-changed, judgment, and cascades to grandchildren", () => {
	let { s } = judgingWorld();
	// e3 consumes e2's checkoutPage (grandchild of the behavior change).
	s = run(s, { type: "entry.create", agent: "t", lane: "tests", producerId: "e2", consumes: ["checkoutPage"] });
	s = run(s, {
		type: "fork.done", entryId: "e3", repo: "arb-e3-tests-0", remote: "x", baseCommit: "p1",
		exports: { checkoutPage: "u1" },
	});
	const r = runEff(s, {
		type: "judge.done", consumerId: "e2", producerId: "e1", commit: "p3", generation: 0,
		verdicts: [{ symbol: "createOrder", probability: 0.9, model: "jev-1.0" }],
	});
	const e2 = entry(r.state, "e2");
	assert.equal(e2.status, "squashed");
	assert.equal(e2.generation, 1);
	assert.equal(e2.diagnosis?.reason, "behavior-changed");
	assert.deepEqual(e2.diagnosis?.judgment, { model: "jev-1.0", probability: 0.9 });
	assert.deepEqual(e2.diagnosis?.changed, [
		{ symbol: "createOrder", oldHash: "b1", newHash: "b2", oldSignature: "sig1", newSignature: "sig1" },
	]);
	assert.equal(e2.diagnosis?.producerCommit, "p3");
	assert.equal(r.state.stats.judgments, 1);
	assert.equal(r.state.stats.semanticSquashes, 1);
	assert.equal(r.state.stats.squashes, 2); // e2 + e3 cascade
	assert.equal(entry(r.state, "e3").status, "squashed");
	assert.equal(entry(r.state, "e3").diagnosis?.reason, "producer-squashed");
	const judged = events(r.effects, "jev.judged")[0];
	assert.equal(judged.entryId, "e2");
	assert.deepEqual(judged.data, {
		producerId: "e1", symbol: "createOrder", probability: 0.9, verdict: "squash", commit: "p3", model: "jev-1.0",
	});
});

test("judge.done: 0.4 <= p < 0.7 warns without squashing", () => {
	const { s } = judgingWorld();
	const r = runEff(s, {
		type: "judge.done", consumerId: "e2", producerId: "e1", commit: "p3", generation: 0,
		verdicts: [{ symbol: "createOrder", probability: 0.5 }],
	});
	assert.equal(entry(r.state, "e2").status, "speculating");
	assert.equal((events(r.effects, "jev.judged")[0].data as { verdict: string }).verdict, "warn");
	assert.equal(r.state.stats.judgments, 1);
	assert.equal(r.state.stats.semanticSquashes, 0);
	assert.deepEqual(entry(r.state, "e2").judging, []);
});

test("judge.done: p < 0.4 clears", () => {
	const { s } = judgingWorld();
	const r = runEff(s, {
		type: "judge.done", consumerId: "e2", producerId: "e1", commit: "p3", generation: 0,
		verdicts: [{ symbol: "createOrder", probability: 0.2 }],
	});
	assert.equal(entry(r.state, "e2").status, "speculating");
	assert.equal((events(r.effects, "jev.judged")[0].data as { verdict: string }).verdict, "clear");
	assert.equal(r.state.stats.squashes, 0);
});

test("judge.done: a null probability emits jev.unavailable and counts nothing", () => {
	const { s } = judgingWorld();
	const r = runEff(s, {
		type: "judge.done", consumerId: "e2", producerId: "e1", commit: "p3", generation: 0,
		verdicts: [{ symbol: "createOrder", probability: null, reason: "http-401" }],
	});
	const ev = events(r.effects, "jev.unavailable")[0];
	assert.equal(ev.entryId, "e2");
	assert.deepEqual(ev.data, { producerId: "e1", symbol: "createOrder", reason: "http-401" });
	assert.equal(events(r.effects, "jev.judged").length, 0);
	assert.equal(r.state.stats.judgments, 0);
	assert.equal(entry(r.state, "e2").status, "speculating");
	assert.deepEqual(entry(r.state, "e2").judging, []);
});

test("judge.done: stale producer commit drops the verdict; a newer push re-judges", () => {
	let { s } = judgingWorld();
	// Producer moves on before the verdict lands; the body changed again, so
	// the mark is re-pointed at p4 and a fresh judge effect fires.
	const p4 = runEff(s, {
		type: "push", repo: "arb-e1-api-0", commit: "p4",
		exports: { createOrder: "h1", helper: "hx" },
		bodies: { createOrder: "b3", helper: "bx" },
	});
	s = p4.state;
	assert.equal(judges(p4.effects).length, 1);
	assert.equal(judges(p4.effects)[0].commit, "p4");
	const r = runEff(s, {
		type: "judge.done", consumerId: "e2", producerId: "e1", commit: "p3", generation: 0,
		verdicts: [{ symbol: "createOrder", probability: 0.95 }],
	});
	s = r.state;
	assert.equal(entry(s, "e2").status, "speculating");
	assert.equal(events(r.effects, "jev.judged").length, 0);
	assert.equal(s.stats.squashes, 0);
	// The newer p4 mark is untouched: the symbol is still gated.
	assert.deepEqual(entry(s, "e2").judging, ["createOrder"]);
	// Its verdict lands normally.
	const r2 = runEff(s, {
		type: "judge.done", consumerId: "e2", producerId: "e1", commit: "p4", generation: 0,
		verdicts: [{ symbol: "createOrder", probability: 0.1 }],
	});
	assert.deepEqual(entry(r2.state, "e2").judging, []);
});

test("judge.done: stale consumer generation drops the verdict", () => {
	let { s } = judgingWorld();
	// Interface squash bumps the consumer's generation while judging is pending.
	s = run(s, { type: "push", repo: "arb-e1-api-0", commit: "p4", exports: { createOrder: "h9" }, sigs: { createOrder: "sig9" } });
	assert.equal(entry(s, "e2").status, "squashed");
	const r = runEff(s, {
		type: "judge.done", consumerId: "e2", producerId: "e1", commit: "p3", generation: 0,
		verdicts: [{ symbol: "createOrder", probability: 0.95 }],
	});
	assert.equal(events(r.effects, "jev.judged").length, 0);
	assert.equal(events(r.effects, "squash").length, 0); // no extra squash beyond the interface one
});

test("judge.done: several squashed symbols keep the highest-probability judgment", () => {
	let s = declaredWorld();
	s = run(s, { type: "entry.create", agent: "x", lane: "x", producerId: "e1", consumes: ["createOrder", "helper"] });
	s = run(s, {
		type: "fork.done", entryId: "e3", repo: "arb-e3-x-0", remote: "x", baseCommit: "p1",
		exports: { createOrder: "h1", helper: "hx" },
		sigs: { createOrder: { signature: "sig1", file: "src/api/order.ts" }, helper: { signature: "sigx", file: "src/api/util.ts" } },
	});
	s = run(s, { type: "push", repo: "arb-e1-api-0", commit: "p2", exports: { createOrder: "h1", helper: "hx" }, bodies: { createOrder: "b1", helper: "bx" } });
	const jr = runEff(s, { type: "push", repo: "arb-e1-api-0", commit: "p3", exports: { createOrder: "h1", helper: "hx" }, bodies: { createOrder: "b2", helper: "bx2" } });
	s = jr.state;
	const e3Judge = judges(jr.effects).find((j) => j.consumerId === "e3");
	assert.deepEqual(e3Judge?.symbols.sort(), ["createOrder", "helper"]);
	const r = runEff(s, {
		type: "judge.done", consumerId: "e3", producerId: "e1", commit: "p3", generation: 0,
		verdicts: [
			{ symbol: "createOrder", probability: 0.8 },
			{ symbol: "helper", probability: 0.95, model: "jev-1.0" },
		],
	});
	const e3 = entry(r.state, "e3");
	assert.equal(e3.status, "squashed");
	assert.deepEqual(e3.diagnosis?.judgment, { model: "jev-1.0", probability: 0.95 });
	assert.equal(e3.diagnosis?.changed.length, 2);
	assert.equal(r.state.stats.judgments, 2);
	assert.equal(r.state.stats.semanticSquashes, 1); // one squash event, not per symbol
});

// --- retirement gate + sweep -------------------------------------------------

test("a consumer with pending judgments does not start checks or retirement", () => {
	let { s } = judgingWorld();
	// Retire e1 first so e2 becomes head.
	s = run(s, { type: "entry.ready", entryId: "e1", commit: "p3" });
	s = run(s, { type: "check.done", entryId: "e1", result: { commit: "p3", passed: 1, failed: 0, durationMs: 1, results: [] } });
	s = run(s, { type: "retire.done", entryId: "e1", commit: "trunk1" });
	// e2 is head: ready -> must NOT flip to checking while judging.
	const r = runEff(s, { type: "entry.ready", entryId: "e2", commit: "p1" });
	s = r.state;
	assert.equal(entry(s, "e2").status, "ready");
	assert.equal(r.effects.filter((e) => e.type === "check").length, 0);
	// The clear verdict unblocks the pipeline.
	const r2 = runEff(s, {
		type: "judge.done", consumerId: "e2", producerId: "e1", commit: "p3", generation: 0,
		verdicts: [{ symbol: "createOrder", probability: 0.1 }],
	});
	assert.equal(r2.effects.filter((e) => e.type === "check").length, 1);
	assert.equal(entry(r2.state, "e2").status, "checking");
});

test("sweep clears judging marks older than 60s as unavailable (reason stale)", () => {
	const { s } = judgingWorld();
	assert.equal(events(runEff(s, { type: "sweep" }, NOW + STALE_MARKER_MS).effects, "jev.unavailable").length, 0);
	const r = runEff(s, { type: "sweep" }, NOW + STALE_MARKER_MS + 1);
	assert.deepEqual(entry(r.state, "e2").judging, []);
	const ev = events(r.effects, "jev.unavailable")[0];
	assert.equal(ev.entryId, "e2");
	assert.deepEqual(ev.data, { producerId: "e1", symbol: "createOrder", reason: "stale" });
});

// --- defaults / forward-fill -------------------------------------------------

test("reset restores the new stats counters", () => {
	let s = inferredWorld();
	s = run(s, { type: "reset" });
	assert.equal(s.stats.judgments, 0);
	assert.equal(s.stats.semanticSquashes, 0);
	assert.equal(s.stats.inferredDeps, 0);
});

test("persisted v1 entries forward-fill the V2 fields and keep working", () => {
	const loaded: RobState = JSON.parse(JSON.stringify(declaredWorld()));
	for (const e of loaded.entries) {
		delete (e as Partial<typeof e>).judging;
		delete (e as Partial<typeof e>).bodies;
		delete (e as Partial<typeof e>).forkedExports;
		delete (e as Partial<typeof e>).consumesInferred;
	}
	delete (loaded._internal as { judgeMarks?: unknown }).judgeMarks;
	delete (loaded._internal as { files?: unknown }).files;
	delete (loaded._internal as { depsReported?: unknown }).depsReported;
	delete (loaded.stats as { judgments?: number }).judgments;
	delete (loaded.stats as { semanticSquashes?: number }).semanticSquashes;
	delete (loaded.stats as { inferredDeps?: number }).inferredDeps;
	migrateState(loaded);
	// The first bodies-bearing push on a v1 entry only records the baseline
	// (there is no known prior bodyHash to compare against).
	let r = runEff(loaded, {
		type: "push", repo: "arb-e1-api-0", commit: "p2",
		exports: { createOrder: "h1", helper: "hx" },
		sigs: { createOrder: { signature: "sig1", file: "src/api/order.ts" } },
		bodies: { createOrder: "b2", helper: "bx" },
	});
	assert.deepEqual(entry(r.state, "e2").judging, []);
	// The next push with a body change judges, and its verdict applies.
	r = runEff(r.state, {
		type: "push", repo: "arb-e1-api-0", commit: "p3",
		exports: { createOrder: "h1", helper: "hx" },
		bodies: { createOrder: "b3", helper: "bx" },
	});
	assert.deepEqual(entry(r.state, "e2").judging, ["createOrder"]);
	r = runEff(r.state, {
		type: "judge.done", consumerId: "e2", producerId: "e1", commit: "p3", generation: 0,
		verdicts: [{ symbol: "createOrder", probability: 0.9 }],
	});
	assert.equal(r.state.stats.judgments, 1);
	assert.equal(entry(r.state, "e2").status, "squashed");
	assert.equal(entry(r.state, "e2").diagnosis?.reason, "behavior-changed");
});
