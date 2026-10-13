// Sharding helpers (T14): pure functions shared by the Worker, the ArbRouter
// DO and tests. A "component" is one connected producer/consumer DAG; its key
// is the component's root entry id.

import type { ArbEvent, BufferState } from "./rob.ts";

/** Public component name for the component rooted at `rootEntryId`
 * (exposed as `entry.component` in GET /api/state). */
export function componentName(rootEntryId: string): string {
	return `comp-${rootEntryId}`;
}

/** Deploy epoch for component DO instances (T19, review F10). Durable Objects
 * with a warm alarm can stay pinned to the previous deployment, and component
 * names restart at `comp-e1` with a fresh router — so the DO *instance* name
 * carries an epoch that is bumped on deploys that change persisted state or
 * RPC shape. The public `component` field stays `comp-<root>`. */
export const COMPONENT_EPOCH = "v2";

/** idFromName() key for a component DO. */
export function componentInstance(component: string): string {
	return `${COMPONENT_EPOCH}:${component}`;
}

/** Public component name from a DO instance name (inverse of componentInstance;
 * tolerant of un-prefixed names). */
export function componentFromInstance(instance: string): string {
	const i = instance.indexOf(":");
	return i >= 0 ? instance.slice(i + 1) : instance;
}

/** ArbRouter persisted state (pure, so reset semantics are unit-testable). */
export interface RouterState {
	nextSeq: number;
	/** entryId -> component name. */
	entryComp: Record<string, string>;
	/** repo name -> component name (registered by components on fork.done). */
	repoComp: Record<string, string>;
	/** Live component names (for aggregation + fan-out). */
	components: string[];
	/** Trunk info learned at /api/trunk/init (components get it on create). */
	trunk: { repo: string; remote: string; commit: string | null } | null;
	robSize: number;
}

export function emptyRouterState(): RouterState {
	return { nextSeq: 0, entryComp: {}, repoComp: {}, components: [], trunk: null, robSize: 8 };
}

/** POST /api/reset on the router: forget every entry and component, keep the
 * trunk, restore the default robSize (review F1), and keep `nextSeq`
 * monotonic (review F10) so post-reset entries get fresh ids, fresh fork
 * names and fresh component DOs instead of colliding with leftovers. */
export function resetRouterState(st: RouterState): RouterState {
	return { ...emptyRouterState(), trunk: st.trunk, nextSeq: st.nextSeq };
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
		judgments: 0,
		semanticSquashes: 0,
		inferredDeps: 0,
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
