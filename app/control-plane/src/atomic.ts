// Atomic retirement cycle (T17). One call = one fully serialized attempt
// loop, run inside ArbTrunk's mutation queue so that no other component can
// land on trunk between the head read and the branch move:
//
//   read head -> decide fast-forward vs path-disjoint splice -> build the
//   candidate -> run checks on it -> move main.
//
// If the move is still rejected (trunk moved underneath the candidate — the
// T16 wedge), the loop rebuilds from the NEW head and re-checks, bounded by
// `maxAttempts`. Every failure is recorded on `attempts[]` so the caller can
// replay `retire.retry`/`retire.failed` events; nothing here can wedge.
//
// Pure async orchestration over ports — no Cloudflare or git imports, so the
// retry logic is unit-testable with fakes (test/atomic.test.ts).

import type {
	AtomicAttempt,
	AtomicRetireResult,
	CheckerPort,
	RetireArgs,
	RetirerPort,
} from "./ports.ts";

/** Bounded rebuilds per atomic cycle (read head -> candidate -> check -> move). */
export const MAX_ATOMIC_ATTEMPTS = 3;

/** Failure text for events: scrub credentials embedded in git remote URLs. */
export function sanitizeReason(e: unknown): string {
	const msg = String(e instanceof Error ? e.message : e);
	return msg.replace(/(https?:\/\/)[^\s/"']*@/g, "$1***@").slice(0, 300);
}

export async function retireAtomic(
	args: RetireArgs,
	deps: { retirer: RetirerPort; checker: CheckerPort },
	maxAttempts: number = MAX_ATOMIC_ATTEMPTS,
): Promise<AtomicRetireResult> {
	const t0 = Date.now();
	const ms = (): Record<string, number> => ({ total: Date.now() - t0 });
	const attempts: AtomicAttempt[] = [];

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const rec: AtomicAttempt = { attempt };
		attempts.push(rec);
		try {
			const res = await deps.retirer.retire(args);
			if (res.outcome === "fast-forward") {
				return { outcome: "fast-forward", commit: res.commit, attempts, ms: ms() };
			}
			if (res.outcome === "overlap") {
				// P ∩ Q ≠ ∅ against the CURRENT head — the entry must be
				// re-based (trunk-overlap squash). Not retried: rebuilding on
				// the same head can only reproduce the same collision.
				return { outcome: "overlap", overlap: res.overlap, p: res.p, q: res.q, attempts, ms: ms() };
			}
			// Splice candidate built on the head retire() just read. Check the
			// exact commit that is about to become trunk, then move main —
			// still inside the same serialized queue slot.
			rec.candidate = res.candidate;
			rec.check = await deps.checker.runChecks(args.toRepo, res.candidate);
			if (rec.check.failed > 0) {
				// A verdict, not a race: rebuilding the same paths can only
				// reproduce the same failures.
				return { outcome: "check-failed", candidate: res.candidate, attempts, ms: ms() };
			}
			try {
				await deps.retirer.moveBranch({ toRepo: args.toRepo, branch: args.branch, commit: res.candidate });
			} catch (e) {
				// Non-fast-forward (or transient) rejection: trunk moved between
				// the candidate build and the move. Rebuild from the new head.
				rec.reason = sanitizeReason(e);
				continue;
			}
			return { outcome: "splice", commit: res.candidate, candidate: res.candidate, attempts, ms: ms() };
		} catch (e) {
			rec.reason = sanitizeReason(e);
		}
	}

	return {
		outcome: "retry-exhausted",
		reason: attempts[attempts.length - 1]?.reason ?? "retire attempts exhausted",
		attempts,
		ms: ms(),
	};
}
