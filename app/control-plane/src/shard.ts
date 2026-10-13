// Sharding helpers (T14): pure functions shared by the Worker, the ArbRouter
// DO and tests. A "component" is one connected producer/consumer DAG; its key
// is the component's root entry id.

import type { ArbEvent, BufferState } from "./rob.ts";

/** DO name for the component rooted at `rootEntryId`. */
export function componentName(rootEntryId: string): string {
	return `comp-${rootEntryId}`;
}

/** "e7" from a fork repo name like "arb-e7-ui-0" or "arb-e7-ui-0-x12"
 * (the -xN suffix is the repo-collision alias). Returns null for anything
 * that does not match the entry-fork naming scheme (e.g. "arb-trunk"). */
export function repoToEntryId(repo: string): string | null {
	const m = /^arb-e(\d+)-/.exec(repo);
	return m ? `e${m[1]}` : null;
}

/** Aggregate per-component public states into one BufferState for
 * GET /api/state. `entries` are concatenated and re-sorted by the global seq;
 * `stats` are summed; `trunk.repo`/`commit` come from the trunk owner and
 * `trunk.retiredCount` is the sum of each component's own count. */
export function mergeStates(
	parts: BufferState[],
	trunk: { repo: string; commit: string | null },
	robSize: number,
): BufferState {
	const entries = parts.flatMap((p) => p.entries).sort((a, b) => a.seq - b.seq);
	const stats: BufferState["stats"] = {
		squashes: 0,
		earlyCutoffs: 0,
		retired: 0,
		checksRun: 0,
		pushesSeen: 0,
		predictionHits: 0,
		predictionMisses: 0,
	};
	let retiredCount = 0;
	for (const p of parts) {
		for (const k of Object.keys(stats) as Array<keyof typeof stats>) stats[k] += p.stats[k] ?? 0;
		retiredCount += p.trunk.retiredCount;
	}
	return { trunk: { repo: trunk.repo, commit: trunk.commit, retiredCount }, robSize, entries, stats };
}

/** Merge per-component event logs into one log ordered by ts, capped at the
 * last 200 (the same bound each component applies to its own log). */
export function mergeEvents(logs: ArbEvent[][], cap = 200): ArbEvent[] {
	return logs.flat().sort((a, b) => a.ts - b.ts).slice(-cap);
}
