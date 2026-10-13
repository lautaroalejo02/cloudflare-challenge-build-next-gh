// T17 regression tests for the atomic retire cycle (src/atomic.ts). All
// pure-logic: fake RetirerPort/CheckerPort drive every failure path —
// concurrent retirements racing on one trunk, rejection -> rebuild, check
// verdicts and the retry bound — with no git, DOs or Cloudflare imports.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ATOMIC_BACKOFF_MS, retireAtomic, sanitizeReason } from "../src/atomic.ts";
import type { CheckResult } from "../src/rob.ts";
import type {
	CheckerPort,
	RetireArgs,
	RetireOutcome,
	RetirerPort,
} from "../src/ports.ts";

const ARGS: RetireArgs = {
	fromRepo: "arb-e1-api-0",
	commit: "c1",
	baseCommit: "t0",
	toRepo: "arb-trunk",
	branch: "main",
};

function okCheck(commit: string): CheckResult {
	return { commit, passed: 2, failed: 0, durationMs: 7, results: [] };
}

function failCheck(commit: string): CheckResult {
	return { commit, passed: 0, failed: 1, durationMs: 9, results: [{ name: "t", ok: false, error: "boom" }] };
}

/** Scripted retirer + recording checker. `retireImpl`/`moveImpl` run per call. */
function fakePorts(opts: {
	retireImpl?: (call: number) => Promise<RetireOutcome>;
	moveImpl?: (call: number, commit: string) => Promise<void>;
	checkImpl?: (commit: string) => CheckResult | Promise<CheckResult>;
}) {
	const calls = { retire: 0, move: 0, checks: [] as string[] };
	const retirer: RetirerPort = {
		retire: async () => {
			calls.retire += 1;
			if (opts.retireImpl) return opts.retireImpl(calls.retire);
			return { outcome: "splice", candidate: `cand${calls.retire}`, ms: {} };
		},
		moveBranch: async ({ commit }) => {
			calls.move += 1;
			if (opts.moveImpl) return opts.moveImpl(calls.move, commit);
		},
	};
	const checker: CheckerPort = {
		runChecks: async (_repo, commit) => {
			calls.checks.push(commit);
			return (opts.checkImpl ?? okCheck)(commit);
		},
	};
	return { retirer, checker, calls };
}

test("fast-forward: lands without a candidate check or moveBranch", async () => {
	const { retirer, checker, calls } = fakePorts({
		retireImpl: async () => ({ outcome: "fast-forward", commit: "c1", ms: {} }),
	});
	const res = await retireAtomic(ARGS, { retirer, checker });
	assert.equal(res.outcome, "fast-forward");
	assert.equal(res.commit, "c1");
	assert.equal(calls.move, 0);
	assert.equal(calls.checks.length, 0);
	assert.equal(res.attempts.length, 1);
	assert.equal(res.attempts[0].reason, undefined);
});

test("splice: candidate checked once and moved inside one attempt", async () => {
	const { retirer, checker, calls } = fakePorts({});
	const res = await retireAtomic(ARGS, { retirer, checker });
	assert.equal(res.outcome, "splice");
	assert.equal(res.commit, "cand1");
	assert.deepEqual(calls.checks, ["cand1"]); // checks ran on the landed commit
	assert.equal(calls.move, 1);
	assert.equal(res.attempts.length, 1);
	assert.equal(res.attempts[0].check?.commit, "cand1");
	assert.equal(res.attempts[0].reason, undefined);
});

test("rejected move -> rebuild from the new head and RE-CHECK (the T16 race)", async () => {
	let moves = 0;
	const { retirer, checker, calls } = fakePorts({
		moveImpl: async () => {
			moves += 1;
			if (moves === 1) throw new Error("Push rejected because it was not a simple fast-forward.");
		},
	});
	const res = await retireAtomic(ARGS, { retirer, checker });
	assert.equal(res.outcome, "splice");
	assert.equal(res.commit, "cand2");
	// Two full attempts: candidate1 checked+rejected, candidate2 checked+landed.
	assert.equal(calls.retire, 2);
	assert.deepEqual(calls.checks, ["cand1", "cand2"]);
	assert.equal(calls.move, 2);
	assert.equal(res.attempts.length, 2);
	assert.equal(res.attempts[0].candidate, "cand1");
	assert.match(res.attempts[0].reason ?? "", /fast-forward/i);
	assert.equal(res.attempts[1].reason, undefined);
});

test("persistent rejection -> retry-exhausted after the bound, never wedged", async () => {
	const { retirer, checker } = fakePorts({
		moveImpl: async () => {
			throw new Error("Push rejected because it was not a simple fast-forward.");
		},
	});
	const res = await retireAtomic(ARGS, { retirer, checker });
	assert.equal(res.outcome, "retry-exhausted");
	assert.match(res.reason, /fast-forward/i);
	assert.equal(res.attempts.length, 3);
	assert.ok(res.attempts.every((a) => a.reason));
	// Every rebuilt candidate was checked before its (rejected) move.
	assert.deepEqual(res.attempts.map((a) => a.check?.commit), ["cand1", "cand2", "cand3"]);
});

test("failed candidate check -> check-failed verdict, no move, no retry", async () => {
	const { retirer, checker, calls } = fakePorts({ checkImpl: failCheck });
	const res = await retireAtomic(ARGS, { retirer, checker });
	assert.equal(res.outcome, "check-failed");
	assert.equal(res.candidate, "cand1");
	assert.equal(calls.move, 0);
	assert.equal(calls.retire, 1); // a verdict, not a race — no rebuild
	assert.equal(res.attempts[0].check?.failed, 1);
});

test("overlap -> trunk-overlap outcome, no check, no move, no retry", async () => {
	const { retirer, checker, calls } = fakePorts({
		retireImpl: async () => ({
			outcome: "overlap",
			overlap: ["src/api/order.ts"],
			p: ["src/api/order.ts"],
			q: ["src/api/order.ts", "src/ui/x.ts"],
			ms: {},
		}),
	});
	const res = await retireAtomic(ARGS, { retirer, checker });
	assert.equal(res.outcome, "overlap");
	assert.deepEqual(res.overlap, ["src/api/order.ts"]);
	assert.equal(calls.move, 0);
	assert.equal(calls.checks.length, 0);
});

test("a thrown retire() counts as a failed attempt and is retried", async () => {
	const { retirer, checker, calls } = fakePorts({
		retireImpl: async (n) => {
			if (n === 1) throw new Error("fetch failed: 1104");
			return { outcome: "fast-forward", commit: "c1", ms: {} };
		},
	});
	const res = await retireAtomic(ARGS, { retirer, checker });
	assert.equal(res.outcome, "fast-forward");
	assert.equal(res.attempts.length, 2);
	assert.match(res.attempts[0].reason ?? "", /1104/);
	assert.equal(calls.retire, 2);
});

/**
 * The T16 defect, end to end: two components retire onto one trunk. A shared
 * fake trunk only accepts a candidate whose parent is the CURRENT head —
 * exactly what a non-FF server rejection enforces. Serialized through the
 * same single-writer queue ArbTrunk uses, both calls land in order; the
 * second one sees the first's landing and splices onto it.
 */
test("two components racing on one trunk both land (serialized atomic)", async () => {
	let head = "t0";
	let candidateSeq = 0;
	const parents = new Map<string, string>();
	const landings: string[] = [];
	const retirer: RetirerPort = {
		retire: async () => {
			// Candidate's parent is the head READ NOW — the atomic slot holds
			// the queue across check+move, so this can never go stale.
			const candidate = `cand${++candidateSeq}`;
			parents.set(candidate, head);
			return { outcome: "splice", candidate, ms: {} };
		},
		moveBranch: async ({ commit }) => {
			if (parents.get(commit) !== head) throw new Error("not a simple fast-forward");
			head = commit;
			landings.push(commit);
		},
	};
	const checker: CheckerPort = {
		runChecks: async (_repo, commit) => {
			await new Promise((r) => setTimeout(r, 5)); // open the old race window
			return okCheck(commit);
		},
	};
	// ArbTrunk's single mutation queue.
	let queue: Promise<unknown> = Promise.resolve();
	const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
		const p = queue.then(fn);
		queue = p.then(() => undefined, () => undefined);
		return p;
	};

	const args = (commit: string): RetireArgs => ({ ...ARGS, commit });
	const [a, b] = await Promise.all([
		enqueue(() => retireAtomic(args("cA"), { retirer, checker })),
		enqueue(() => retireAtomic(args("cB"), { retirer, checker })),
	]);
	assert.equal(a.outcome, "splice");
	assert.equal(b.outcome, "splice");
	// B's candidate was built on A's landed head — zero rejections needed.
	assert.equal(b.attempts.filter((x) => x.reason).length, 0);
	assert.equal(landings.length, 2);
	assert.equal(parents.get(landings[0]), "t0");
	assert.equal(parents.get(landings[1]), landings[0]);
});

test("sanitizeReason strips credentials embedded in remote URLs", () => {
	const err = new Error("push https://x:secret-token@artifacts.example.com/arb-trunk failed");
	const reason = sanitizeReason(err);
	assert.ok(!reason.includes("secret-token"), reason);
	assert.ok(reason.includes("https://***@artifacts.example.com"), reason);
	assert.equal(sanitizeReason("plain string"), "plain string");
});

// --- T19 review F2: backoff + infra candidate checks -----------------------------

test("backoff: rebuild attempts wait ~0.5 s then ~1 s (F2)", async () => {
	const { retirer, checker } = fakePorts({
		moveImpl: async () => {
			throw new Error("non-fast-forward");
		},
	});
	const slept: number[] = [];
	const res = await retireAtomic(ARGS, { retirer, checker, sleep: async (ms) => void slept.push(ms) });
	assert.equal(res.outcome, "retry-exhausted");
	assert.deepEqual(slept, [500, 1000]);
	assert.deepEqual(ATOMIC_BACKOFF_MS, [500, 1000, 2000]);
});

test("infra candidate check is a retryable attempt, not a check-failed verdict (F2)", async () => {
	let n = 0;
	const { retirer, checker } = fakePorts({
		checkImpl: (commit) => {
			n += 1;
			return n === 1 ? { ...failCheck(commit), infra: true } : okCheck(commit);
		},
	});
	const res = await retireAtomic(ARGS, { retirer, checker, sleep: async () => {} });
	assert.equal(res.outcome, "splice");
	assert.equal(res.attempts.length, 2);
	assert.match(res.attempts[0].reason ?? "", /infra/);
});
