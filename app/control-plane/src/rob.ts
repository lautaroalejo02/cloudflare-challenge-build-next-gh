// Pure reorder-buffer state machine. No Cloudflare imports: it takes commands
// and returns the next state plus effects for the interpreter (the Durable
// Object) to execute through ports. `apply` mutates and returns `state`.

export type Lane = string;
export type SymbolHashes = Record<string, string>;
export type SymbolSignatures = Record<string, string>;

export type EntryStatus =
	| "speculating"
	| "squashed"
	| "ready"
	| "checking"
	| "retired"
	| "failed"
	| "vetoed";

export interface Diagnosis {
	reason:
		| "interface-changed"
		| "producer-vetoed"
		| "producer-squashed"
		| "trunk-overlap"
		| "prediction-miss"
		/** (V2) Jev judged the producer's body-only change behavior-visible. */
		| "behavior-changed";
	changed: Array<{
		symbol: string;
		oldHash: string;
		newHash: string;
		oldSignature: string;
		newSignature: string;
	}>;
	producerCommit: string;
	/** (V2) Present only for `behavior-changed`: the highest-probability
	 * Jev verdict behind the squash. */
	judgment?: { model: string; probability: number };
}

/** (V2) An import edge, as extracted by the hasher (app/hasher `ImportRef`). */
export interface ImportRef {
	/** Importing file, repo-relative. */
	file: string;
	/** Resolved imported file (repo-relative for relative specifiers, the
	 * specifier as written for bare ones). */
	from: string;
	/** Imported binding names; `"*"` = namespace import. */
	names: string[];
}

/** (V2) Signature map arriving on push/fork.done commands: either the plain
 * signature text or `{ signature, file }` when the hasher knows the
 * declaring file (needed by import-based dependency inference). */
export type SigField = Record<string, string | { signature: string; file?: string }>;

/** (V2) One per-symbol Jev verdict carried by `judge.done`. */
export interface JudgeVerdict {
	symbol: string;
	/** Jev probability in [0,1], or null when judging was unavailable. */
	probability: number | null;
	model?: string;
	reason?: string;
}

export interface CheckResult {
	commit: string;
	passed: number;
	failed: number;
	durationMs: number;
	results: Array<{ name: string; ok: boolean; error?: string }>;
	/** True when the checker could not run at all (Artifacts/loader/network
	 * failure) — an infra error, NOT a test verdict. Infra results are never
	 * stored on `entry.checks` and never flip the entry to failed/ready; the
	 * check is retried by the stale-marker sweep. */
	infra?: boolean;
}

export interface Entry {
	id: string;
	seq: number;
	agent: string;
	lane: Lane;
	status: EntryStatus;
	repo: string;
	remote: string;
	producerId: string | null;
	baseCommit: string;
	headCommit: string | null;
	exports: SymbolHashes;
	consumes: SymbolHashes;
	/** (V2) True when `consumes` was omitted at registration and is derived
	 * from the entry's imports on every push. */
	consumesInferred: boolean;
	/** (V2) The producer's `exports` snapshot at this entry's latest
	 * (re-)fork ({} when forked from trunk): the baseline for inference. */
	forkedExports: SymbolHashes;
	/** (V2) Exported symbol -> bodyHash at headCommit. */
	bodies: SymbolHashes;
	/** (V2) Consumed symbols with a pending Jev judgment; non-empty blocks
	 * checks and retirement. */
	judging: string[];
	/** Symbols whose `exports` values are unconfirmed stub predictions
	 * (declared at registration). Cleared when the entry's first real push
	 * resolves them against reality. */
	predicted: string[];
	generation: number;
	diagnosis: Diagnosis | null;
	checks: CheckResult | null;
}

export interface BufferState {
	trunk: { repo: string; commit: string | null; retiredCount: number };
	robSize: number;
	entries: Entry[];
	stats: {
		squashes: number;
		earlyCutoffs: number;
		retired: number;
		checksRun: number;
		pushesSeen: number;
		/** (consumer, symbol) pairs where the producer's declared stub matched
		 * the first real push. */
		predictionHits: number;
		/** (consumer, symbol) pairs where reality diverged from the stub. */
		predictionMisses: number;
		/** (V2) Jev judgments completed (non-null verdicts). */
		judgments: number;
		/** (V2) Squashes caused by Jev verdicts. */
		semanticSquashes: number;
		/** (V2) Consumed symbols derived from imports. */
		inferredDeps: number;
	};
}

export interface ArbEvent {
	type:
		| "entry.created"
		| "push"
		| "hash.unchanged"
		| "hash.changed"
		| "squash"
		| "refork"
		| "ready"
		| "check.started"
		| "check.passed"
		| "check.failed"
		| "prediction.hit"
		| "prediction.miss"
		| "retire.retry"
		| "retire.failed"
		| "retired"
		| "veto"
		| "config"
		| "reset"
		/** (V2) Newly inferred consumed symbols; `entryId` = consumer,
		 * `data` = { producerId, symbols: Record<name, hash> }. */
		| "deps.inferred"
		/** (V2, best effort) The consumer imports files another live entry
		 * owns without declaring it; `data` = { fromEntryId, paths, symbols }. */
		| "deps.undeclared"
		/** (V2) A Jev verdict landed; `data` = { producerId, symbol,
		 * probability, verdict, commit, model }. */
		| "jev.judged"
		/** (V2) Jev was unreachable/stale; `data` = { producerId, symbol,
		 * reason }. Treated as `clear`. */
		| "jev.unavailable"
		/** Recovery narration (T19): a stale in-flight marker was swept and the
		 * work re-issued, or an effect threw and was reported instead of
		 * wedging the queue. `data` carries {kind, entryId?, detail?}. */
		| "recover";
	ts: number;
	entryId?: string;
	data?: unknown;
}

/** Hot-path indexes over `entries` (T14). Persisted as plain objects inside
 * `_internal` (JSON-serializable); `ensureIdx` rebuilds them when missing or
 * when `entries.length` moved outside the machine (direct test/bench writes).
 *
 * `entries[]` is kept sorted by seq so `byId` maps id -> seq and lookups do a
 * binary search: insertions may arrive out of order because the router assigns
 * global seqs before the component DO applies the create.
 */
export interface RobIndexes {
	/** entryId -> seq (position via binary search into the seq-sorted array). */
	byId: Record<string, number>;
	/** current repo name -> entryId (all entries; `live` re-checked at read). */
	byRepo: Record<string, string>;
	/** producerId -> dependent entryIds. */
	childrenOf: Record<string, string[]>;
	/** planned fork repo -> entryId (reverse of `pending`). */
	pendingRepo: Record<string, string>;
	/** entries[] index of the lowest-seq live entry; advances monotonically. */
	headCursor: number;
	/** Non-retired entries (robSize accounting; vetoed still count). */
	active: number;
	/** Highest seq assigned so far (creates may carry an explicit seq). */
	lastSeq: number;
	/** entries.length these indexes cover (staleness check for ensureIdx). */
	n: number;
}

/** Interpreter-owned bookkeeping, persisted alongside BufferState but
 * stripped from GET /api/state responses. */
export interface RobInternal {
	/** entryId -> symbol -> normalized signature text (for diagnosis). */
	sigs: Record<string, SymbolSignatures>;
	/** entryId -> repo name of a fork currently in flight. */
	pending: Record<string, string>;
	/** entryId -> ts when the fork effect was emitted (stale-marker sweep). */
	pendingStart: Record<string, number>;
	/** entryId -> source repo of the in-flight fork, so the sweep can
	 * re-issue exactly the same fork (T19). */
	pendingFrom: Record<string, string>;
	/** entryId -> consecutive failed fork attempts for the current planned
	 * fork (T19 recovery; cleared when a fork lands). */
	forkFails: Record<string, number>;
	/** entryId -> earliest ts the sweep may re-issue a failed fork (backoff). */
	forkRetryAt: Record<string, number>;
	/** entryId -> commit a check is running against. */
	checking: Record<string, string>;
	/** entryId -> ts when the check effect was emitted. */
	checkStart: Record<string, number>;
	/** entryId -> earliest ts the sweep re-issues a check whose last run was
	 * an infra failure (T19; faster than the STALE_MARKER_MS fallback). */
	checkRetryAt: Record<string, number>;
	/** entryId -> a retire effect is in flight. */
	retiring: Record<string, true>;
	/** entryId -> consecutive exhausted atomic-retire cycles for the current
	 * head (T17). Bounds the component-level auto-retry: cascade re-fires
	 * while < MAX_RETIRE_CYCLES, then stops until a push/ready resets it. */
	retireStrikes: Record<string, number>;
	/** entryId -> ts when the retire effect was emitted (durationMs). */
	retireStart: Record<string, number>;
	/** "repo:commit" push dedupe (queue + alarm poll may both fire). */
	seenPushes: string[];
	/** Planned repo name -> actual name when a fork had to use a suffix
	 * (name collision with a repo left over from before a reset). */
	repoAlias: Record<string, string>;
	/** Consumer entryId -> consumed symbols pinned to the producer's declared
	 * stub hash at registration. Pinned consumes survive the consumer's own
	 * fork.done (the fork carries the pre-push base) and are released when the
	 * producer's first push resolves its predictions. */
	predConsumed: Record<string, string[]>;
	/** (V2) entryId -> exported symbol -> repo-relative declaring file
	 * (drives import-based dependency inference and `deps.undeclared`). */
	files: Record<string, SymbolHashes>;
	/** (V2) consumerId -> consumed symbol -> pending Jev mark (sweep +
	 * staleness bookkeeping; `judging` on the entry is the public view). */
	judgeMarks: Record<string, Record<string, JudgeMark>>;
	/** (V2) entryId -> "fromEntryId|path" keys already reported through
	 * `deps.undeclared` (dedupe per import edge). */
	depsReported: Record<string, string[]>;
	/** Bounded event log for debugging. */
	eventLog: ArbEvent[];
	/** Hot-path indexes (T14); maintained by apply(), rebuilt when stale. */
	idx?: RobIndexes;
}

/** (V2) Bookkeeping for one pending Jev judgment on a consumed symbol. */
export interface JudgeMark {
	/** When the judgment was emitted (stale-marker sweep). */
	at: number;
	/** Producer commit the judgment is about (staleness + judge.done match). */
	commit: string;
	producerId: string;
	/** Body hashes for the behavior-changed diagnosis. */
	oldBody: string;
	newBody: string;
}

export interface RobState extends BufferState {
	_internal: RobInternal;
}

export function initialState(): RobState {
	return {
		trunk: { repo: "", commit: null, retiredCount: 0 },
		robSize: 8,
		entries: [],
		stats: {
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
		},
		_internal: {
			sigs: {},
			pending: {},
			pendingStart: {},
			pendingFrom: {},
			forkFails: {},
			forkRetryAt: {},
			checking: {},
			checkStart: {},
			checkRetryAt: {},
			retiring: {},
			retireStrikes: {},
			retireStart: {},
			seenPushes: [],
			repoAlias: {},
			predConsumed: {},
			files: {},
			judgeMarks: {},
			depsReported: {},
			eventLog: [],
			idx: emptyIndexes(),
		},
	};
}

/** BufferState view served by the API: internal fields stripped. */
export function publicState(state: RobState): BufferState {
	const { _internal, ...pub } = state;
	return pub;
}

// --- commands ---------------------------------------------------------------

export type Cmd =
	| { type: "trunk.init"; repo: string; remote: string; commit: string | null }
	| {
			type: "entry.create";
			agent: string;
			lane: string;
			producerId?: string;
			consumes?: string[];
			/** Declared-stub prediction: the producer's intended exported
			 * interface, already hashed by the interpreter. */
			stub?: { exports: SymbolHashes; sigs: SigField };
			/** Sharded control plane (T14): the router assigns the global id/seq
			 * before the component DO applies the create. */
			id?: string;
			seq?: number;
	  }
	| {
			type: "fork.done";
			entryId: string;
			repo: string;
			remote: string;
			baseCommit: string;
			exports: SymbolHashes;
			sigs?: SigField;
			/** (V2) Exported symbol -> bodyHash of the forked content. */
			bodies?: SymbolHashes;
			/** Planned name the fork effect targeted (`Effect.fork.toRepo`). A
			 * fork.done whose planned name no longer matches the entry's
			 * pending fork was superseded by a newer re-fork and is dropped. */
			planned?: string;
	  }
	/** The fork effect threw (T19): keep `pending` (the agent still has no
	 * fork), record the failure and let the sweep re-issue it with backoff. */
	| { type: "fork.failed"; entryId: string; planned?: string; reason: string }
	/** A non-fork effect threw (token, broadcast, ...): narrate it as a
	 * `recover` event; the effect queue continues (T19). */
	| { type: "effect.failed"; entryId?: string; effect: string; reason: string }
	| {
			type: "push";
			repo: string;
			commit: string;
			exports?: SymbolHashes;
			sigs?: SigField;
			/** (V2) Import edges of the pushed tree (hasher `extractImports`). */
			imports?: ImportRef[];
			/** (V2) Exported symbol -> bodyHash of the pushed content. */
			bodies?: SymbolHashes;
	  }
	/** (V2) Jev verdicts for one consumer/producer pair (one judge effect). */
	| {
			type: "judge.done";
			consumerId: string;
			producerId: string;
			commit: string;
			generation: number;
			verdicts: JudgeVerdict[];
	  }
	| { type: "entry.ready"; entryId: string; commit: string }
	| { type: "check.done"; entryId: string; result: CheckResult }
	/** One atomic-cycle attempt rebuilt after a rejected trunk move (T17).
	 * Narration only — `retiring` stays set; the final outcome follows. */
	| { type: "retire.retry"; entryId: string; attempt: number; reason: string }
	/** The atomic cycle ran checks on a splice candidate (on the trunk repo).
	 * Passed -> events only; failed -> the entry goes `failed`. */
	| { type: "retire.checked"; entryId: string; candidate: string; result: CheckResult }
	/** The atomic cycle exhausted its rebuilds (or the RPC failed): clear
	 * `retiring`, emit `retire.failed`, and let the next cascade retry
	 * (bounded by retireStrikes). */
	| { type: "retire.failed"; entryId: string; reason: string }
	/** P ∩ Q ≠ ∅ at retire time: squash the entry (trunk-overlap). */
	| { type: "retire.overlap"; entryId: string; overlap: string[] }
	| {
			type: "retire.done";
			entryId: string;
			commit: string;
			/** Entry head that was retired; ignored if head moved since. */
			entryCommit?: string;
			mode?: "fast-forward" | "splice";
	  }
	| { type: "entry.veto"; entryId: string }
	| { type: "config.set"; robSize: number }
	/** Stale-marker sweep (T19): in-flight fork/check/retire markers older
	 * than STALE_MARKER_MS are presumed lost (effect threw, DO restarted
	 * mid-effect, or the RPC silently died). Clears them so the trailing
	 * cascade re-issues the work; emits `recover` events. */
	| { type: "sweep" }
	| { type: "reset" };

export type Effect =
	| { type: "fork"; entryId: string; fromRepo: string; toRepo: string }
	| { type: "token"; entryId: string; repo: string }
	| { type: "check"; entryId: string; repo: string; commit: string }
	| { type: "retire"; entryId: string; fromRepo: string; commit: string; baseCommit: string; toRepo: string; branch: string }
	/** (V2) Judge `symbols` of `producerId` at `commit` for `consumerId`
	 * (generation pins the consumer view the verdict applies to). */
	| { type: "judge"; consumerId: string; producerId: string; symbols: string[]; commit: string; generation: number }
	| { type: "broadcast"; event: ArbEvent };

export type ApplyResult =
	| { ok: true; state: RobState; effects: Effect[] }
	| { ok: false; status: number; error: string };

// --- helpers ---------------------------------------------------------------

function err(status: number, error: string): ApplyResult {
	return { ok: false, status, error };
}

// --- index maps (T14) ---------------------------------------------------------

export function emptyIndexes(): RobIndexes {
	return { byId: {}, byRepo: {}, childrenOf: {}, pendingRepo: {}, headCursor: 0, active: 0, lastSeq: 0, n: 0 };
}

/** (V2) Defaults for Entry fields added after v1, used to forward-fill
 * persisted/hand-built entries. */
export function entryDefaults(): Pick<Entry, "consumesInferred" | "forkedExports" | "bodies" | "judging"> {
	return { consumesInferred: false, forkedExports: {}, bodies: {}, judging: [] };
}

/** Split a `SigField` into plain signatures + declaring files. */
function splitSigs(field: SigField | undefined): { sigs: SymbolSignatures; files: SymbolHashes } {
	const sigs: SymbolSignatures = {};
	const files: SymbolHashes = {};
	for (const [k, v] of Object.entries(field ?? {})) {
		if (typeof v === "string") sigs[k] = v;
		else {
			sigs[k] = v.signature;
			if (v.file) files[k] = v.file;
		}
	}
	return { sigs, files };
}

/** Clear an entry's pending judgments (squash/re-fork/terminal state makes
 * any in-flight verdict moot). */
function clearJudging(state: RobState, e: Entry): void {
	e.judging = [];
	delete state._internal.judgeMarks[e.id];
}

/** Rebuild every index from `entries` + `pending` (re-sorts entries by seq).
 * Called on first apply after load/persist-restore, and whenever `entries`
 * changed size outside the machine. */
export function rebuildIndexes(state: RobState): RobIndexes {
	const entries = state.entries;
	entries.sort((a, b) => a.seq - b.seq);
	const i = emptyIndexes();
	for (const e of entries) {
		// (V2) forward-fill fields absent from v1-persisted entries.
		Object.assign(e, entryDefaults(), e);
		i.byId[e.id] = e.seq;
		if (e.repo) i.byRepo[e.repo] = e.id;
		if (e.producerId) (i.childrenOf[e.producerId] ??= []).push(e.id);
		if (e.status !== "retired") i.active += 1;
		if (e.seq > i.lastSeq) i.lastSeq = e.seq;
	}
	// (V2) forward-fill stats/internal maps added after v1.
	state.stats = { ...initialState().stats, ...state.stats };
	const ii = state._internal;
	ii.files ??= {};
	ii.judgeMarks ??= {};
	ii.depsReported ??= {};
	for (const [id, repo] of Object.entries(state._internal.pending)) i.pendingRepo[repo] = id;
	while (i.headCursor < entries.length && !live(entries[i.headCursor])) i.headCursor++;
	i.n = entries.length;
	state._internal.idx = i;
	return i;
}

/** The maintained index set. Rebuilds lazily when absent or when `entries`
 * changed size behind the machine's back (tests/bench build states directly). */
function idx(state: RobState): RobIndexes {
	const i = state._internal.idx;
	if (!i || i.n !== state.entries.length) return rebuildIndexes(state);
	return i;
}

/** Index of `seq` in the seq-sorted entries array, or -1. */
function indexOfSeq(entries: Entry[], seq: number): number {
	let lo = 0;
	let hi = entries.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (entries[mid].seq === seq) return mid;
		if (entries[mid].seq < seq) lo = mid + 1;
		else hi = mid - 1;
	}
	return -1;
}

function find(state: RobState, id: string): Entry | undefined {
	const seq = idx(state).byId[id];
	if (seq === undefined) return undefined;
	const i = indexOfSeq(state.entries, seq);
	if (i >= 0 && state.entries[i].id === id) return state.entries[i];
	// Defensive: an index should never disagree with the array; if it does,
	// fall back to a scan rather than returning a wrong entry.
	return state.entries.find((e) => e.id === id);
}

/** Live entry holding `repo` as its CURRENT fork name, or undefined. */
function entryByRepo(state: RobState, repo: string): Entry | undefined {
	const id = idx(state).byRepo[repo];
	if (!id) return undefined;
	const e = find(state, id);
	return e && live(e) ? e : undefined;
}

/** Dependents of `producerId` in registration order (all statuses). */
function children(state: RobState, producerId: string): Entry[] {
	const ids = idx(state).childrenOf[producerId];
	if (!ids) return [];
	const out: Entry[] = [];
	for (const id of ids) {
		const e = find(state, id);
		if (e) out.push(e);
	}
	return out;
}

function setPending(state: RobState, id: string, repo: string, now: number, fromRepo: string): void {
	state._internal.pending[id] = repo;
	state._internal.pendingStart[id] = now;
	state._internal.pendingFrom[id] = fromRepo;
	idx(state).pendingRepo[repo] = id;
}

function clearPending(state: RobState, id: string): void {
	const repo = state._internal.pending[id];
	if (repo !== undefined) delete idx(state).pendingRepo[repo];
	delete state._internal.pending[id];
	delete state._internal.pendingStart[id];
	delete state._internal.pendingFrom[id];
}

function live(e: Entry): boolean {
	return e.status !== "retired" && e.status !== "vetoed";
}

/** Lowest-seq entry that can still retire (not retired, not vetoed). The
 * cursor only advances: entries are sorted by seq and retired/vetoed is
 * terminal, so the head never moves back. */
function head(state: RobState): Entry | undefined {
	const i = idx(state);
	while (i.headCursor < state.entries.length && !live(state.entries[i.headCursor])) i.headCursor++;
	return state.entries[i.headCursor];
}

function emit(state: RobState, effects: Effect[], now: number, ev: Omit<ArbEvent, "ts">): void {
	const event: ArbEvent = { ...ev, ts: now };
	effects.push({ type: "broadcast", event });
	state._internal.eventLog.push(event);
	if (state._internal.eventLog.length > 200) state._internal.eventLog.shift();
}

function forkEffect(state: RobState, effects: Effect[], e: Entry, fromRepo: string, now: number): string {
	const toRepo = `arb-e${e.seq}-${e.lane}-${e.generation}`;
	setPending(state, e.id, toRepo, now, fromRepo);
	effects.push({ type: "fork", entryId: e.id, fromRepo, toRepo });
	return toRepo;
}

/** Remove `id` from `childrenOf[oldProducer]` and append under `newProducer`
 * (undefined = reparent to trunk, i.e. no producer). */
function reparent(state: RobState, id: string, oldProducer: string | null, newProducer: string | null | undefined): void {
	if (newProducer === undefined) return;
	const i = idx(state);
	if (oldProducer) {
		const list = i.childrenOf[oldProducer];
		if (list) {
			const k = list.indexOf(id);
			if (k >= 0) list.splice(k, 1);
			if (!list.length) delete i.childrenOf[oldProducer];
		}
	}
	if (newProducer) (i.childrenOf[newProducer] ??= []).push(id);
}

/** Diff a consumer's recorded hashes against fresh producer exports. */
function consumedDiff(
	consumes: SymbolHashes,
	newExports: SymbolHashes,
	oldSigs: SymbolSignatures,
	newSigs: SymbolSignatures,
): Diagnosis["changed"] {
	const changed: Diagnosis["changed"] = [];
	for (const sym of Object.keys(consumes)) {
		const newHash = newExports[sym] ?? "";
		if (consumes[sym] !== newHash) {
			changed.push({
				symbol: sym,
				oldHash: consumes[sym],
				newHash,
				oldSignature: oldSigs[sym] ?? "",
				newSignature: newSigs[sym] ?? "",
			});
		}
	}
	return changed;
}

/**
 * Squash `e` and, transitively, every live entry that (in)directly depends on
 * it. `baseRepo`/`baseExports`/`baseSigs` describe what the re-fork will
 * contain (the producer's new head for interface-changed, the vetoed entry's
 * base for producer-vetoed, the parent's new repo for producer-squashed).
 */
function squashTree(
	state: RobState,
	effects: Effect[],
	now: number,
	producer: Entry,
	reason: Diagnosis["reason"],
	baseRepo: string,
	baseExports: SymbolHashes,
	baseSigs: SymbolSignatures,
	producerCommit: string,
	reparentTo: string | null | undefined,
): void {
	// Diagnose dependents against their DIRECT producer (T19, review F11):
	// after its re-fork, `producer` exposes the new base content plus its own
	// still-declared stub symbols. A vetoed producer's declarations die with it.
	if (reason !== "producer-vetoed" && producer.predicted.length) {
		const ownSigs = state._internal.sigs[producer.id] ?? {};
		baseExports = { ...baseExports };
		baseSigs = { ...baseSigs };
		for (const sym of producer.predicted) {
			baseExports[sym] = producer.exports[sym] ?? "";
			baseSigs[sym] = ownSigs[sym] ?? "";
		}
	}
	for (const c of children(state, producer.id).filter(live)) {
		// Rebase target for THIS dependent.
		let fromRepo = baseRepo;
		let newExports = baseExports;
		let newSigs = baseSigs;
		if (reason === "producer-squashed") {
			// Refork from the parent's new (in-flight) fork.
			fromRepo = state._internal.pending[producer.id] ?? producer.repo;
		}
		if (reason === "producer-vetoed") {
			// The vetoed producer will never resolve its declared-stub
			// predictions: release this consumer's pins so its re-fork (onto
			// the vetoed entry's base) fills consumes from real content.
			delete state._internal.predConsumed[c.id];
		}
		const oldSigs = state._internal.sigs[c.id] ?? {};
		const changed = consumedDiff(c.consumes, newExports, oldSigs, newSigs);
		c.generation += 1;
		c.status = "squashed";
		c.diagnosis = { reason, changed, producerCommit };
		clearJudging(state, c);
		if (reparentTo !== undefined) {
			reparent(state, c.id, c.producerId, reparentTo);
			c.producerId = reparentTo;
		}
		state.stats.squashes += 1;
		const newRepo = forkEffect(state, effects, c, fromRepo, now);
		emit(state, effects, now, {
			type: "squash",
			entryId: c.id,
			data: { reason, changed, generation: c.generation, repo: newRepo },
		});
		// Its own dependents collapse onto its new fork.
		squashTree(state, effects, now, c, "producer-squashed", newRepo, newExports, newSigs, producerCommit, undefined);
	}
}

/** Component-level retry bound for exhausted atomic-retire cycles (T17).
 * Below it the next cascade re-fires retirement automatically; at it the
 * entry parks at `failed` until a push or a fresh `entry.ready` resets the
 * strike count. */
export const MAX_RETIRE_CYCLES = 3;

/** In-flight fork/check/retire markers older than this are presumed lost and
 * re-issued by the sweep (T19). */
export const STALE_MARKER_MS = 60_000;

/** First retry delay for a failed fork; doubles per consecutive failure,
 * capped at STALE_MARKER_MS (T19). */
export const FORK_RETRY_BASE_MS = 2_000;

/** Re-check delay after an infra (non-verdict) check failure (T19). */
export const INFRA_RECHECK_MS = 10_000;

/** Advance the retirement pipeline: the head entry checks, then retires. */
function cascade(state: RobState, effects: Effect[], now: number): void {
	const h = head(state);
	// (V2) pending Jev judgments gate checks and retirement — a later verdict
	// may still squash this entry, so the pipeline waits for the judgment
	// (bounded by the 60 s stale-mark sweep).
	if (!h || state._internal.pending[h.id] || (h.judging?.length ?? 0) > 0) return;
	if (h.status === "ready" && !state._internal.checking[h.id]) {
		if (!h.checks || h.checks.commit !== h.headCommit) {
			h.status = "checking";
			state._internal.checking[h.id] = h.headCommit!;
			state._internal.checkStart[h.id] = now;
			delete state._internal.checkRetryAt[h.id];
			effects.push({ type: "check", entryId: h.id, repo: h.repo, commit: h.headCommit! });
			emit(state, effects, now, { type: "check.started", entryId: h.id, data: { commit: h.headCommit } });
			return;
		}
		if (
			h.checks.failed === 0 &&
			!state._internal.retiring[h.id] &&
			(state._internal.retireStrikes[h.id] ?? 0) < MAX_RETIRE_CYCLES
		) {
			state._internal.retiring[h.id] = true;
			state._internal.retireStart[h.id] = now;
			effects.push({
				type: "retire",
				entryId: h.id,
				fromRepo: h.repo,
				commit: h.headCommit!,
				baseCommit: h.baseCommit,
				toRepo: state.trunk.repo,
				branch: "main",
			});
		}
	}
}

// --- the machine ------------------------------------------------------------

export function apply(state: RobState, cmd: Cmd, now = Date.now()): ApplyResult {
	const effects: Effect[] = [];
	// (V2) forward-fill fields missing from v1-persisted states; idx() may
	// skip rebuildIndexes when the index still matches, so this runs here.
	state.stats = { ...initialState().stats, ...state.stats };
	const ii0 = state._internal;
	ii0.files ??= {};
	ii0.judgeMarks ??= {};
	ii0.depsReported ??= {};
	for (const e of state.entries) {
		if (e.judging === undefined) Object.assign(e, entryDefaults(), e);
	}
	idx(state); // heal indexes if entries moved outside the machine

	switch (cmd.type) {
		case "trunk.init": {
			if (state.trunk.repo && state.trunk.repo !== cmd.repo) {
				return err(409, `trunk already initialized as ${state.trunk.repo}`);
			}
			state.trunk.repo = cmd.repo;
			state.trunk.commit = cmd.commit ?? state.trunk.commit;
			break;
		}

		case "entry.create": {
			const ix = idx(state);
			if (ix.active >= state.robSize) return err(409, "reorder buffer full");
			let producer: Entry | undefined;
			if (cmd.producerId) {
				producer = find(state, cmd.producerId);
				if (!producer) return err(404, `producer ${cmd.producerId} not found`);
				if (!live(producer)) return err(409, `producer ${cmd.producerId} is ${producer.status}`);
			} else if (!state.trunk.repo) {
				return err(409, "trunk not initialized");
			}
			const seq = cmd.seq ?? ix.lastSeq + 1;
			const id = cmd.id ?? `e${seq}`;
			// Value prediction: a consumer of a stubbed producer records the
			// PREDICTED hash (what it forwards against), not the fork's base
			// content. Pinned symbols are kept in _internal.predConsumed until
			// the producer's first push resolves them.
			const producerPredicted = producer?.predicted ?? [];
			const consumes: SymbolHashes = {};
			const pinned: string[] = [];
			for (const s of cmd.consumes ?? []) {
				if (producer && producerPredicted.includes(s)) {
					consumes[s] = producer.exports[s] ?? "";
					pinned.push(s);
				} else {
					consumes[s] = "";
				}
			}
			// (V2) `consumes` omitted on a produced entry => infer it from
			// imports on every push (explicit [] still counts as declared).
			const consumesInferred = cmd.consumes === undefined && producer !== undefined;
			const entry: Entry = {
				id,
				seq,
				agent: cmd.agent,
				lane: cmd.lane,
				status: "speculating",
				repo: "",
				remote: "",
				producerId: cmd.producerId ?? null,
				baseCommit: "",
				headCommit: null,
				exports: cmd.stub ? { ...cmd.stub.exports } : {},
				consumes,
				consumesInferred,
				forkedExports: {},
				bodies: {},
				judging: [],
				predicted: cmd.stub ? Object.keys(cmd.stub.exports) : [],
				generation: 0,
				diagnosis: null,
				checks: null,
			};
			// entries stays sorted by seq: a sharded create may carry a seq
			// lower than entries already applied (router assigns before apply).
			let pos = state.entries.length;
			while (pos > 0 && state.entries[pos - 1].seq > seq) pos--;
			state.entries.splice(pos, 0, entry);
			ix.n = state.entries.length;
			ix.byId[id] = seq;
			if (entry.producerId) (ix.childrenOf[entry.producerId] ??= []).push(id);
			ix.active += 1;
			if (seq > ix.lastSeq) ix.lastSeq = seq;
			// Inserting at/before the cursor shifts the head right — the new
			// live entry then occupies the earliest live position.
			if (pos <= ix.headCursor) ix.headCursor = pos;
			if (pinned.length) state._internal.predConsumed[id] = pinned;
			if (cmd.stub) {
				const stubMaps = splitSigs(cmd.stub.sigs);
				state._internal.sigs[id] = stubMaps.sigs;
				state._internal.files[id] = stubMaps.files;
			}
			const fromRepo = producer ? producer.repo : state.trunk.repo;
			const repo = forkEffect(state, effects, entry, fromRepo, now);
			entry.repo = repo;
			ix.byRepo[repo] = id;
			emit(state, effects, now, {
				type: "entry.created",
				entryId: id,
				data: {
					agent: entry.agent,
					lane: entry.lane,
					seq,
					producerId: entry.producerId,
					repo,
					exports: entry.exports,
					consumes: entry.consumes,
					consumesInferred: entry.consumesInferred,
					predicted: entry.predicted,
				},
			});
			break;
		}

		case "fork.done": {
			const e = find(state, cmd.entryId);
			if (!e) return err(404, `entry ${cmd.entryId} not found`);
			// Superseded or orphaned fork (T19): a newer re-fork replaced this
			// one, or a veto cleared the pending marker. Adopting it would point
			// the entry at a fork nobody is waiting for.
			if (cmd.planned !== undefined && state._internal.pending[e.id] !== cmd.planned) break;
			const wasSquash = e.status === "squashed";
			const oldRepo = e.repo;
			e.repo = cmd.repo;
			{
				const ix = idx(state);
				if (oldRepo && ix.byRepo[oldRepo] === e.id) delete ix.byRepo[oldRepo];
				ix.byRepo[cmd.repo] = e.id;
			}
			e.remote = cmd.remote;
			e.baseCommit = cmd.baseCommit;
			e.headCommit = cmd.baseCommit;
			// A fresh base makes every pending judgment moot (generation moved).
			clearJudging(state, e);
			e.bodies = cmd.bodies ?? {};
			const newSigs = splitSigs(cmd.sigs);
			// A stubbed producer's fork carries its pre-push base: keep the
			// declared (predicted) hashes and signatures for predicted symbols
			// until the first real push resolves them against reality.
			if (e.predicted.length) {
				const keep: SymbolHashes = {};
				const keepSig: SymbolSignatures = {};
				const keepFile: SymbolHashes = {};
				const curSigs = state._internal.sigs[e.id] ?? {};
				const curFiles = state._internal.files[e.id] ?? {};
				for (const sym of e.predicted) {
					keep[sym] = e.exports[sym];
					keepSig[sym] = curSigs[sym] ?? "";
					if (curFiles[sym]) keepFile[sym] = curFiles[sym];
				}
				e.exports = { ...cmd.exports, ...keep };
				state._internal.sigs[e.id] = { ...newSigs.sigs, ...keepSig };
				state._internal.files[e.id] = { ...newSigs.files, ...keepFile };
			} else {
				e.exports = cmd.exports;
				state._internal.sigs[e.id] = newSigs.sigs;
				state._internal.files[e.id] = newSigs.files;
			}
			// Consumes pinned to a producer's stub prediction keep the declared
			// hash, not the fork's (pre-push) content; unpinned ones fill in.
			const pinned = new Set(state._internal.predConsumed[e.id] ?? []);
			for (const sym of Object.keys(e.consumes)) {
				if (!pinned.has(sym)) e.consumes[sym] = cmd.exports[sym] ?? e.consumes[sym];
			}
			const planned = state._internal.pending[e.id];
			if (planned && planned !== cmd.repo) state._internal.repoAlias[planned] = cmd.repo;
			clearPending(state, e.id);
			delete state._internal.retireStrikes[e.id];
			delete state._internal.forkFails[e.id];
			delete state._internal.forkRetryAt[e.id];
			// Producer drifted while this fork was in flight (T19, review F4): a
			// producer push that lands during the fork only refreshes the
			// diagnosis (the pending dedupe), so the base this fork captured may
			// predate the producer's current head. When the fork's base is not
			// the producer's current head, re-diff every unpinned consumed
			// symbol against the producer's CURRENT exports; any mismatch means
			// the new fork is already stale — squash and re-fork immediately
			// instead of handing out its token. Pinned stub symbols are skipped:
			// they resolve on the producer's first push (prediction verdicts).
			const producer = e.producerId ? find(state, e.producerId) : undefined;
			// (V2) Snapshot the producer's exports at (re-)fork time: the
			// baseline every import-inferred consumes value is pinned to.
			e.forkedExports = producer ? { ...producer.exports } : {};
			if (
				producer &&
				live(producer) &&
				live(e) &&
				!state._internal.pending[producer.id] &&
				producer.headCommit &&
				producer.headCommit !== cmd.baseCommit
			) {
				const prodSigs = state._internal.sigs[producer.id] ?? {};
				const eSigs = state._internal.sigs[e.id] ?? {};
				const unpinned: SymbolHashes = {};
				for (const sym of Object.keys(e.consumes)) if (!pinned.has(sym)) unpinned[sym] = e.consumes[sym];
				const changed = consumedDiff(unpinned, producer.exports, eSigs, prodSigs);
				if (changed.length) {
					const producerCommit = producer.headCommit;
					emit(state, effects, now, {
						type: "hash.changed",
						entryId: e.id,
						data: { producerId: producer.id, commit: producerCommit, changed, drift: true },
					});
					e.generation += 1;
					e.status = "squashed";
					e.diagnosis = { reason: "interface-changed", changed, producerCommit };
					state.stats.squashes += 1;
					const newRepo = forkEffect(state, effects, e, producer.repo, now);
					emit(state, effects, now, {
						type: "squash",
						entryId: e.id,
						data: { reason: "interface-changed", changed, generation: e.generation, repo: newRepo, drift: true },
					});
					squashTree(state, effects, now, e, "producer-squashed", newRepo, producer.exports, prodSigs, producerCommit, undefined);
					break; // fork already stale: no token, no refork announce
				}
			}
			effects.push({ type: "token", entryId: e.id, repo: e.repo });
			if (wasSquash) {
				emit(state, effects, now, {
					type: "refork",
					entryId: e.id,
					data: { repo: e.repo, baseCommit: e.baseCommit, generation: e.generation },
				});
			}
			break;
		}

		case "push": {
			const key = `${cmd.repo}:${cmd.commit}`;
			if (state._internal.seenPushes.includes(key)) return { ok: true, state, effects };
			if (cmd.repo === state.trunk.repo && cmd.commit === state.trunk.commit) {
				return { ok: true, state, effects };
			}
			const e = entryByRepo(state, cmd.repo);
			const pendingId = idx(state).pendingRepo[cmd.repo];
			if (!e && cmd.repo !== state.trunk.repo && !pendingId) return { ok: true, state, effects };
			if (e && e.headCommit === cmd.commit) return { ok: true, state, effects };
			state._internal.seenPushes.push(key);
			if (state._internal.seenPushes.length > 500) state._internal.seenPushes.shift();

			if (cmd.repo === state.trunk.repo) {
				state.trunk.commit = cmd.commit;
				emit(state, effects, now, { type: "push", data: { repo: cmd.repo, commit: cmd.commit, trunk: true } });
				break;
			}
			const target = e ?? find(state, pendingId!)!;
			// Ignore ALL pushes while a fork/re-fork for this entry is in flight:
			// the agent has no write token yet, so anything arriving is either
			// the old fork or — because /api/reset does not delete repos — a
			// stale repo that happens to share the planned name. Adopting its
			// commits would alias the entry onto old content (observed live:
			// stale fork repos named `arb-e<seq>-<lane>-<n>` persist across runs).
			// The fork's own head is set by fork.done anyway.
			if (state._internal.pending[target.id]) {
				break;
			}
			target.headCommit = cmd.commit;
			// Snapshot declared-stub predictions before the real push overwrites
			// them; a push carrying hashes resolves them exactly once.
			const predictedSyms = cmd.exports ? target.predicted.slice() : [];
			const predSigs = { ...(state._internal.sigs[target.id] ?? {}) };
			if (cmd.exports) target.exports = cmd.exports;
			if (cmd.sigs) {
				const maps = splitSigs(cmd.sigs);
				state._internal.sigs[target.id] = maps.sigs;
				state._internal.files[target.id] = maps.files;
			}
			const oldBodies = { ...(target.bodies ?? {}) };
			if (cmd.bodies) target.bodies = cmd.bodies;
			const newBodies = target.bodies ?? {};
			if (predictedSyms.length) target.predicted = [];
			target.diagnosis = null;
			if (target.status === "squashed" || target.status === "failed" || target.status === "ready" || target.status === "checking") {
				target.status = "speculating";
				delete state._internal.checking[target.id];
				delete state._internal.retiring[target.id];
				delete state._internal.retireStrikes[target.id];
				delete state._internal.retireStart[target.id];
			}
			state.stats.pushesSeen += 1;
			emit(state, effects, now, {
				type: "push",
				entryId: target.id,
				data: { repo: cmd.repo, commit: cmd.commit },
			});
			// (V2) Dependency inference: an entry registered without `consumes`
			// fills it from imports of the producer's declaring files, pinned to
			// the hashes its last (re-)fork carried (`forkedExports`). A newly
			// inferred name that already drifted squashes immediately.
			let inferredDrift: Diagnosis["changed"] = [];
			const pushProducer = target.producerId ? find(state, target.producerId) : undefined;
			if (cmd.imports && target.consumesInferred && pushProducer) {
				const prodFiles = state._internal.files[pushProducer.id] ?? {};
				const symsByFile = new Map<string, string[]>();
				for (const [sym, f] of Object.entries(prodFiles)) {
					const list = symsByFile.get(f) ?? [];
					list.push(sym);
					symsByFile.set(f, list);
				}
				const inferred: SymbolHashes = {};
				for (const imp of cmd.imports) {
					const here = symsByFile.get(imp.from);
					if (!here) continue;
					for (const n of imp.names.includes("*") ? here : imp.names) {
						if (!here.includes(n) || n in target.consumes) continue;
						target.consumes[n] = inferred[n] = target.forkedExports[n] ?? "";
					}
				}
				if (Object.keys(inferred).length) {
					state.stats.inferredDeps += Object.keys(inferred).length;
					emit(state, effects, now, {
						type: "deps.inferred",
						entryId: target.id,
						data: { producerId: pushProducer.id, symbols: inferred },
					});
					inferredDrift = consumedDiff(
						inferred,
						pushProducer.exports,
						state._internal.sigs[target.id] ?? {},
						state._internal.sigs[pushProducer.id] ?? {},
					);
				}
			}
			// (V2, best effort) Report imports of files another live,
			// non-ancestor entry owns — i.e. declaring one of ITS exports that
			// no ancestor of `target` provides. Reported once per (entry, file).
			if (cmd.imports) {
				const ancestors = new Set<string>();
				for (let p: string | null = target.producerId; p; ) {
					ancestors.add(p);
					p = find(state, p)?.producerId ?? null;
				}
				const ancExports = new Set<string>();
				for (const a of ancestors) {
					for (const s of Object.keys(find(state, a)?.exports ?? {})) ancExports.add(s);
				}
				const fileOwner = new Map<string, { entryId: string; syms: string[] }>();
				for (const o of state.entries) {
					if (o.id === target.id || !live(o) || ancestors.has(o.id)) continue;
					for (const [sym, f] of Object.entries(state._internal.files[o.id] ?? {})) {
						if (!f || ancExports.has(sym)) continue;
						const rec = fileOwner.get(f) ?? { entryId: o.id, syms: [] };
						rec.syms.push(sym);
						fileOwner.set(f, rec);
					}
				}
				const reported = (state._internal.depsReported[target.id] ??= []);
				const byOwner = new Map<string, { paths: Set<string>; symbols: Set<string> }>();
				for (const imp of cmd.imports) {
					const o = fileOwner.get(imp.from);
					if (!o) continue;
					const key = `${o.entryId}|${imp.from}`;
					if (reported.includes(key)) continue;
					reported.push(key);
					const g = byOwner.get(o.entryId) ?? { paths: new Set<string>(), symbols: new Set<string>() };
					for (const n of imp.names.includes("*") ? o.syms : imp.names) g.symbols.add(n);
					g.paths.add(imp.from);
					byOwner.set(o.entryId, g);
				}
				for (const [fromEntryId, g] of byOwner) {
					emit(state, effects, now, {
						type: "deps.undeclared",
						entryId: target.id,
						data: { fromEntryId, paths: [...g.paths], symbols: [...g.symbols] },
					});
				}
			}
			if (inferredDrift.length && pushProducer) {
				const producerCommit = pushProducer.headCommit ?? "";
				emit(state, effects, now, {
					type: "hash.changed",
					entryId: target.id,
					data: { producerId: pushProducer.id, commit: producerCommit, changed: inferredDrift },
				});
				target.generation += 1;
				target.status = "squashed";
				target.diagnosis = { reason: "interface-changed", changed: inferredDrift, producerCommit };
				clearJudging(state, target);
				state.stats.squashes += 1;
				const newRepo = forkEffect(state, effects, target, pushProducer.repo, now);
				emit(state, effects, now, {
					type: "squash",
					entryId: target.id,
					data: { reason: "interface-changed", changed: inferredDrift, generation: target.generation, repo: newRepo },
				});
				squashTree(
					state, effects, now, target, "producer-squashed", newRepo,
					pushProducer.exports, state._internal.sigs[pushProducer.id] ?? {}, producerCommit, undefined,
				);
				break;
			}
			// Compare each live consumer's recorded hashes against the new exports.
			const exports = target.exports;
			const sigs = state._internal.sigs[target.id] ?? {};
			for (const c of children(state, target.id).filter(live)) {
				const oldSigs = state._internal.sigs[c.id] ?? {};
				const changed = consumedDiff(c.consumes, exports, oldSigs, sigs);
				// Value prediction verdict: on the producer's first real push,
				// each consumed symbol pinned to a declared-stub hash gets a
				// hit/miss verdict instead of the ordinary diff bookkeeping.
				const pinned = (state._internal.predConsumed[c.id] ?? []).filter((s) =>
					predictedSyms.includes(s),
				);
				if (pinned.length) {
					const missed: Diagnosis["changed"] = [];
					for (const sym of pinned) {
						const actual = exports[sym] ?? "";
						if (c.consumes[sym] === actual) {
							state.stats.predictionHits += 1;
							emit(state, effects, now, {
								type: "prediction.hit",
								entryId: c.id,
								data: { producerId: target.id, symbol: sym, hash: actual, commit: cmd.commit },
							});
						} else {
							state.stats.predictionMisses += 1;
							missed.push({
								symbol: sym,
								oldHash: c.consumes[sym],
								newHash: actual,
								oldSignature: predSigs[sym] ?? "",
								newSignature: sigs[sym] ?? "",
							});
							emit(state, effects, now, {
								type: "prediction.miss",
								entryId: c.id,
								data: {
									producerId: target.id,
									symbol: sym,
									predictedHash: c.consumes[sym],
									actualHash: actual,
									predictedSignature: predSigs[sym] ?? "",
									actualSignature: sigs[sym] ?? "",
									commit: cmd.commit,
								},
							});
						}
					}
					delete state._internal.predConsumed[c.id];
					if (missed.length) {
						// Diagnose predicted-vs-actual for the missed symbols plus any
						// other consumed drift in the same push (the miss wins the
						// reason; the agent still sees every symbol that moved).
						const diagChanged = missed.concat(changed.filter((d) => !pinned.includes(d.symbol)));
						emit(state, effects, now, {
							type: "hash.changed",
							entryId: c.id,
							data: { producerId: target.id, commit: cmd.commit, changed },
						});
						if (state._internal.pending[c.id]) {
							c.diagnosis = { reason: "prediction-miss", changed: diagChanged, producerCommit: cmd.commit };
							continue;
						}
						c.generation += 1;
						c.status = "squashed";
						c.diagnosis = { reason: "prediction-miss", changed: diagChanged, producerCommit: cmd.commit };
						clearJudging(state, c);
						state.stats.squashes += 1;
						const newRepo = forkEffect(state, effects, c, target.repo, now);
						emit(state, effects, now, {
							type: "squash",
							entryId: c.id,
							data: { reason: "prediction-miss", changed: diagChanged, generation: c.generation, repo: newRepo },
						});
						squashTree(state, effects, now, c, "producer-squashed", newRepo, exports, sigs, cmd.commit, undefined);
						continue;
					}
					// All pinned symbols hit; any remaining diff is on symbols the
					// stub never declared -> ordinary interface change below.
					if (changed.length === 0) continue; // pure hit: not a cutoff
				}
				if (changed.length === 0) {
					state.stats.earlyCutoffs += 1;
					emit(state, effects, now, {
						type: "hash.unchanged",
						entryId: c.id,
						data: { producerId: target.id, commit: cmd.commit },
					});
					// (V2) A body-only change on a consumed symbol is behavior
					// territory the interface diff cannot see: keep the cutoff,
					// mark `judging`, and emit ONE judge effect per consumer.
					// A newer push re-marks the symbol for a fresh judgment.
					if (cmd.bodies && c.status !== "squashed") {
						c.judging ??= [];
						const marks = (state._internal.judgeMarks[c.id] ??= {});
						const pending: string[] = [];
						for (const s of Object.keys(c.consumes)) {
							const ob = oldBodies[s];
							// A first-recorded bodyHash is the baseline, not a
							// change: only a known prior body can have changed.
							if (ob === undefined || ob === newBodies[s]) continue;
							if (!c.judging.includes(s)) c.judging.push(s);
							marks[s] = { at: now, commit: cmd.commit, producerId: target.id, oldBody: ob, newBody: newBodies[s] ?? "" };
							pending.push(s);
						}
						if (pending.length) {
							effects.push({
								type: "judge",
								consumerId: c.id,
								producerId: target.id,
								symbols: pending,
								commit: cmd.commit,
								generation: c.generation,
							});
						}
					}
					continue;
				}
				emit(state, effects, now, {
					type: "hash.changed",
					entryId: c.id,
					data: { producerId: target.id, commit: cmd.commit, changed },
				});
				if (state._internal.pending[c.id]) {
					// A refork is already in flight and will pick up this head; keep
					// the diagnosis current but don't fork twice.
					c.diagnosis = { reason: "interface-changed", changed, producerCommit: cmd.commit };
					continue;
				}
				c.generation += 1;
				c.status = "squashed";
				c.diagnosis = { reason: "interface-changed", changed, producerCommit: cmd.commit };
				clearJudging(state, c);
				state.stats.squashes += 1;
				const newRepo = forkEffect(state, effects, c, target.repo, now);
				emit(state, effects, now, {
					type: "squash",
					entryId: c.id,
					data: { reason: "interface-changed", changed, generation: c.generation, repo: newRepo },
				});
				squashTree(state, effects, now, c, "producer-squashed", newRepo, exports, sigs, cmd.commit, undefined);
			}
			break;
		}

		case "judge.done": {
			const c = find(state, cmd.consumerId);
			if (!c) break;
			// Clear the marks THIS verdict answered — but only marks still
			// pointing at the judged commit: a newer push re-marked the symbol
			// for a fresh judgment and must keep it gated.
			const marks = state._internal.judgeMarks[c.id] ?? {};
			const captured: Record<string, JudgeMark> = {};
			for (const v of cmd.verdicts) {
				const m = marks[v.symbol];
				if (m && m.commit === cmd.commit) {
					captured[v.symbol] = m;
					delete marks[v.symbol];
					c.judging = (c.judging ?? []).filter((s) => s !== v.symbol);
				}
			}
			const producer = find(state, cmd.producerId);
			// Stale verdict (contract): the producer's head moved past the
			// judged commit, or the consumer re-forked (generation changed) —
			// drop it.
			if (!producer || producer.headCommit !== cmd.commit || c.generation !== cmd.generation) break;
			const prodSigs = state._internal.sigs[producer.id] ?? {};
			const changed: Diagnosis["changed"] = [];
			let top: { model: string; probability: number } | undefined;
			for (const v of cmd.verdicts) {
				if (v.probability === null || v.probability === undefined) {
					emit(state, effects, now, {
						type: "jev.unavailable",
						entryId: c.id,
						data: { producerId: cmd.producerId, symbol: v.symbol, reason: v.reason ?? "unavailable" },
					});
					continue;
				}
				const verdict = v.probability >= 0.7 ? "squash" : v.probability >= 0.4 ? "warn" : "clear";
				const model = v.model ?? "jev-latest";
				state.stats.judgments += 1;
				emit(state, effects, now, {
					type: "jev.judged",
					entryId: c.id,
					data: {
						producerId: cmd.producerId,
						symbol: v.symbol,
						probability: v.probability,
						verdict,
						commit: cmd.commit,
						model,
					},
				});
				if (verdict === "squash") {
					if (!top || v.probability > top.probability) top = { model, probability: v.probability };
					const m = captured[v.symbol];
					changed.push({
						symbol: v.symbol,
						oldHash: m?.oldBody ?? "",
						newHash: m?.newBody ?? "",
						oldSignature: prodSigs[v.symbol] ?? "",
						newSignature: prodSigs[v.symbol] ?? "",
					});
				}
			}
			if (!changed.length || !live(c) || c.status === "squashed") break;
			if (state._internal.pending[c.id]) {
				c.diagnosis = { reason: "behavior-changed", changed, producerCommit: cmd.commit, judgment: top };
				break;
			}
			c.generation += 1;
			c.status = "squashed";
			c.diagnosis = { reason: "behavior-changed", changed, producerCommit: cmd.commit, judgment: top };
			clearJudging(state, c);
			state.stats.squashes += 1;
			state.stats.semanticSquashes += 1;
			const newRepo = forkEffect(state, effects, c, producer.repo, now);
			emit(state, effects, now, {
				type: "squash",
				entryId: c.id,
				data: {
					reason: "behavior-changed",
					changed,
					generation: c.generation,
					repo: newRepo,
					judgment: top,
				},
			});
			squashTree(state, effects, now, c, "producer-squashed", newRepo, producer.exports, prodSigs, cmd.commit, undefined);
			break;
		}

		case "entry.ready": {
			const e = find(state, cmd.entryId);
			if (!e) return err(404, `entry ${cmd.entryId} not found`);
			if (e.status === "retired" || e.status === "vetoed") return err(409, `entry ${e.id} is ${e.status}`);
			if (state._internal.pending[e.id]) return err(409, `entry ${e.id} refork in progress`);
			// Squashed entries must re-push — unless the refork already landed
			// (head === base) and the agent found nothing to re-apply, in which
			// case readying the fork base is a legitimate no-op retire.
			if (e.status === "squashed" && !(e.headCommit && e.headCommit === e.baseCommit)) {
				return err(409, `entry ${e.id} is squashed; push to the new fork first`);
			}
			if (cmd.commit !== e.headCommit) return err(409, `commit ${cmd.commit} is not head ${e.headCommit}`);
			delete state._internal.retireStrikes[e.id];
			// A re-ready on the same head must re-check: clear a FAILED verdict
			// (the cascade's `checks.commit === headCommit` guard would
			// otherwise trust it forever and wedge the entry at ready).
			if (e.checks && e.checks.failed > 0) e.checks = null;
			e.status = "ready";
			emit(state, effects, now, { type: "ready", entryId: e.id, data: { commit: cmd.commit } });
			break;
		}

		case "check.done": {
			const e = find(state, cmd.entryId);
			if (!e) return err(404, `entry ${cmd.entryId} not found`);
			state.stats.checksRun += 1;
			// Checks are issued from "ready"/"checking" (head). Any other status
			// means the check is stale — applying it could resurrect a
			// retired/squashed entry (observed: a head check completing after
			// retirement flipped e3 back to ready and triggered a phantom
			// trunk-overlap loop).
			if (e.status !== "ready" && e.status !== "checking") {
				delete state._internal.checking[e.id];
				delete state._internal.checkStart[e.id];
				break;
			}
			// Infra failures (T19, review F2): the checker never ran the tests —
			// do NOT store a verdict. Keep the `checking` marker and let the
			// sweep re-issue the check after INFRA_RECHECK_MS.
			if (cmd.result.infra) {
				state._internal.checking[e.id] = e.headCommit ?? cmd.result.commit;
				state._internal.checkStart[e.id] = now;
				state._internal.checkRetryAt[e.id] = now + INFRA_RECHECK_MS;
				e.status = "checking";
				emit(state, effects, now, {
					type: "check.failed",
					entryId: e.id,
					data: { commit: cmd.result.commit, infra: true, error: cmd.result.results[0]?.error ?? "infra" },
				});
				break;
			}
			delete state._internal.checking[e.id];
			delete state._internal.checkStart[e.id];
			if (cmd.result.commit !== e.headCommit) break; // stale check; a push moved head
			// Record only head checks: a splice-candidate result must not
			// clobber entry.checks (its commit never equals the fork head, which
			// would make cascade re-check the head mid-retire).
			e.checks = cmd.result;
			if (cmd.result.failed === 0) {
				e.status = "ready";
				emit(state, effects, now, {
					type: "check.passed",
					entryId: e.id,
					data: { commit: cmd.result.commit, durationMs: cmd.result.durationMs },
				});
			} else {
				e.status = "failed";
				emit(state, effects, now, {
					type: "check.failed",
					entryId: e.id,
					data: { commit: cmd.result.commit, durationMs: cmd.result.durationMs, failed: cmd.result.failed },
				});
			}
			break;
		}

		case "retire.retry": {
			const e = find(state, cmd.entryId);
			if (!e) return err(404, `entry ${cmd.entryId} not found`);
			if (!state._internal.retiring[e.id]) break; // stale: a push moved the entry on
			emit(state, effects, now, {
				type: "retire.retry",
				entryId: e.id,
				data: { attempt: cmd.attempt, reason: cmd.reason },
			});
			break;
		}

		case "retire.checked": {
			const e = find(state, cmd.entryId);
			if (!e) return err(404, `entry ${cmd.entryId} not found`);
			if (!state._internal.retiring[e.id]) break; // stale: a push moved the entry on
			state.stats.checksRun += 1;
			emit(state, effects, now, {
				type: "check.started",
				entryId: e.id,
				data: { commit: cmd.candidate, splice: true },
			});
			if (cmd.result.infra) {
				// The checker could not run (T19): narration only. The atomic
				// cycle treated it as a retryable attempt, not a verdict.
				emit(state, effects, now, {
					type: "check.failed",
					entryId: e.id,
					data: { commit: cmd.result.commit, infra: true, splice: true, error: cmd.result.results[0]?.error ?? "infra" },
				});
				break;
			}
			if (cmd.result.failed === 0) {
				emit(state, effects, now, {
					type: "check.passed",
					entryId: e.id,
					data: { commit: cmd.result.commit, durationMs: cmd.result.durationMs, splice: true },
				});
			} else {
				// The spliced tree itself fails checks: a verdict, not a race —
				// the agent must push again (which re-arms retirement).
				e.status = "failed";
				delete state._internal.retiring[e.id];
				delete state._internal.retireStrikes[e.id];
				delete state._internal.retireStart[e.id];
				emit(state, effects, now, {
					type: "check.failed",
					entryId: e.id,
					data: {
						commit: cmd.result.commit,
						durationMs: cmd.result.durationMs,
						failed: cmd.result.failed,
						splice: true,
					},
				});
			}
			break;
		}

		case "retire.failed": {
			const e = find(state, cmd.entryId);
			if (!e) return err(404, `entry ${cmd.entryId} not found`);
			if (!state._internal.retiring[e.id]) break; // stale: a push moved the entry on
			delete state._internal.retiring[e.id];
			delete state._internal.retireStart[e.id];
			const strikes = (state._internal.retireStrikes[e.id] = (state._internal.retireStrikes[e.id] ?? 0) + 1);
			const exhausted = strikes >= MAX_RETIRE_CYCLES;
			emit(state, effects, now, {
				type: "retire.failed",
				entryId: e.id,
				data: { reason: cmd.reason, strike: strikes, exhausted },
			});
			// Below the bound the trailing cascade re-fires the retire effect
			// automatically. At the bound the entry is parked at `failed` — a
			// push or a fresh `entry.ready` resets the strikes and retries.
			if (exhausted) e.status = "failed";
			break;
		}

		case "retire.overlap": {
			const e = find(state, cmd.entryId);
			if (!e) return err(404, `entry ${cmd.entryId} not found`);
			// Stale overlap (T19): a push/veto moved the entry past this cycle —
			// the atomic attempt's verdict no longer applies.
			if (!state._internal.retiring[e.id] || e.status !== "ready") break;
			delete state._internal.retiring[e.id];
			delete state._internal.retireStrikes[e.id];
			delete state._internal.retireStart[e.id];
			// Squash the entry itself: its agent re-applies the change on a
			// fresh fork of TRUNK. The collision is with trunk content, so the
			// retry must be based on the trunk head — reforking from the
			// producer's repo would keep Q non-empty forever (livelock:
			// observed e3 squash-looped 20+ times on the same overlap).
			// Dependents are left alone — if the re-applied work moves their
			// consumed hashes, the normal push path squashes them.
			const fromRepo = state.trunk.repo;
			e.generation += 1;
			e.status = "squashed";
			e.diagnosis = { reason: "trunk-overlap", changed: [], producerCommit: state.trunk.commit ?? e.baseCommit };
			clearJudging(state, e);
			state.stats.squashes += 1;
			const newRepo = forkEffect(state, effects, e, fromRepo, now);
			emit(state, effects, now, {
				type: "squash",
				entryId: e.id,
				data: { reason: "trunk-overlap", overlap: cmd.overlap, generation: e.generation, repo: newRepo },
			});
			break;
		}

		case "retire.done": {
			const e = find(state, cmd.entryId);
			if (!e) return err(404, `entry ${cmd.entryId} not found`);
			if (e.status === "retired") break; // duplicate land (e.g. a swept, re-issued cycle)
			// Stale land (T19, review F6): a push mid-cycle cleared `retiring`
			// and moved the entry on (or a veto/sweep did), but the atomic cycle
			// still landed `cmd.commit` on trunk. Dropping it would desync
			// state.trunk.commit from reality, and the entry would diff its next
			// retirement against a base that predates already-landed work — so
			// record the landing without retiring the entry: trunk advances and
			// a live entry's base advances to the retired entry commit.
			const current =
				state._internal.retiring[e.id] &&
				e.status === "ready" &&
				(!cmd.entryCommit || e.headCommit === cmd.entryCommit);
			if (!current) {
				if (cmd.entryCommit && live(e)) e.baseCommit = cmd.entryCommit;
				state.trunk.commit = cmd.commit;
				emit(state, effects, now, {
					type: "push",
					data: { repo: state.trunk.repo, commit: cmd.commit, trunk: true, staleRetire: e.id },
				});
				break;
			}
			const startedAt = state._internal.retireStart[e.id];
			const durationMs = startedAt === undefined ? undefined : now - startedAt;
			delete state._internal.retiring[e.id];
			delete state._internal.retireStrikes[e.id];
			delete state._internal.retireStart[e.id];
			e.status = "retired";
			idx(state).active -= 1;
			state.trunk.commit = cmd.commit;
			state.trunk.retiredCount += 1;
			state.stats.retired += 1;
			emit(state, effects, now, {
				type: "retired",
				entryId: e.id,
				data: { commit: cmd.commit, seq: e.seq, mode: cmd.mode ?? "fast-forward", durationMs },
			});
			break;
		}

		case "entry.veto": {
			const e = find(state, cmd.entryId);
			if (!e) return err(404, `entry ${cmd.entryId} not found`);
			const h = head(state);
			if (!h || h.id !== e.id) return err(409, "only the head entry can be vetoed");
			// A retire cycle is in flight for this entry (T19): its outcome
			// arrives asynchronously and would override the veto — reject now.
			if (state._internal.retiring[e.id]) {
				return err(409, `entry ${e.id} is retiring; retry after the cycle lands`);
			}
			e.status = "vetoed";
			clearJudging(state, e);
			clearPending(state, e.id);
			delete state._internal.forkFails[e.id];
			delete state._internal.forkRetryAt[e.id];
			delete state._internal.checking[e.id];
			delete state._internal.checkStart[e.id];
			delete state._internal.retiring[e.id];
			delete state._internal.retireStrikes[e.id];
			delete state._internal.retireStart[e.id];
			emit(state, effects, now, { type: "veto", entryId: e.id, data: { seq: e.seq } });
			// Dependents rebase onto the vetoed entry's own base and are
			// reparented to the vetoed entry's producer.
			const baseRepo = e.producerId ? find(state, e.producerId)!.repo : state.trunk.repo;
			const baseExports = e.producerId ? find(state, e.producerId)!.exports : {};
			const baseSigs = e.producerId ? state._internal.sigs[e.producerId] ?? {} : {};
			squashTree(state, effects, now, e, "producer-vetoed", baseRepo, baseExports, baseSigs, e.headCommit ?? "", e.producerId);
			break;
		}

		case "config.set": {
			if (!Number.isInteger(cmd.robSize) || cmd.robSize < 1) return err(400, "robSize must be a positive integer");
			state.robSize = cmd.robSize;
			emit(state, effects, now, { type: "config", data: { robSize: cmd.robSize } });
			break;
		}

		case "fork.failed": {
			const e = find(state, cmd.entryId);
			if (!e) return err(404, `entry ${cmd.entryId} not found`);
			const planned = state._internal.pending[e.id];
			// Stale failure: the fork was superseded, landed, or vetoed away.
			if (!planned || (cmd.planned !== undefined && planned !== cmd.planned)) break;
			const attempt = (state._internal.forkFails[e.id] ?? 0) + 1;
			const retryInMs = Math.min(STALE_MARKER_MS, FORK_RETRY_BASE_MS * 2 ** (attempt - 1));
			state._internal.forkFails[e.id] = attempt;
			state._internal.forkRetryAt[e.id] = now + retryInMs;
			emit(state, effects, now, {
				type: "recover",
				entryId: e.id,
				data: { kind: "fork-failed", repo: planned, attempt, retryInMs, reason: cmd.reason },
			});
			break;
		}

		case "effect.failed": {
			emit(state, effects, now, {
				type: "recover",
				...(cmd.entryId ? { entryId: cmd.entryId } : {}),
				data: { kind: `${cmd.effect}-failed`, reason: cmd.reason },
			});
			break;
		}

		case "sweep": {
			// Alarm-driven recovery (T19, review F3): re-issue in-flight work
			// whose marker outlived STALE_MARKER_MS (the effect threw, the DO
			// restarted mid-effect, or an RPC silently died), and failed forks
			// whose backoff elapsed. The trailing cascade re-issues checks and
			// retirements once their markers are cleared.
			const ii = state._internal;
			for (const e of state.entries) {
				if (!live(e)) continue;
				// (V2) Jev marks older than the marker TTL are presumed lost
				// (the judge effect threw or the DO restarted): clear them as
				// unavailable so the entry can retire.
				const jm = ii.judgeMarks?.[e.id];
				if (jm && e.judging?.length) {
					for (const sym of [...e.judging]) {
						const m = jm[sym];
						if (m && now - m.at > STALE_MARKER_MS) {
							delete jm[sym];
							e.judging = e.judging.filter((x) => x !== sym);
							emit(state, effects, now, {
								type: "jev.unavailable",
								entryId: e.id,
								data: { producerId: m.producerId, symbol: sym, reason: "stale" },
							});
						}
					}
				}
				const planned = ii.pending[e.id];
				if (planned) {
					const pendAt = ii.pendingStart[e.id];
					const retryAt = ii.forkRetryAt[e.id];
					const failedDue = retryAt !== undefined && now >= retryAt;
					const stale = pendAt !== undefined && now - pendAt > STALE_MARKER_MS;
					if (failedDue || stale) {
						const from =
							ii.pendingFrom[e.id] ??
							(e.producerId ? (find(state, e.producerId)?.repo ?? state.trunk.repo) : state.trunk.repo);
						clearPending(state, e.id);
						delete ii.forkRetryAt[e.id];
						const toRepo = forkEffect(state, effects, e, from, now);
						emit(state, effects, now, {
							type: "recover",
							entryId: e.id,
							data: {
								kind: "refork",
								repo: toRepo,
								attempt: (ii.forkFails[e.id] ?? 0) + 1,
								ageMs: pendAt === undefined ? null : now - pendAt,
							},
						});
					}
					continue;
				}
				const checkAt = ii.checkStart[e.id];
				const checkRetryAt = ii.checkRetryAt[e.id];
				const checkDue =
					(checkRetryAt !== undefined && now >= checkRetryAt) ||
					(checkAt !== undefined && now - checkAt > STALE_MARKER_MS);
				if (ii.checking[e.id] && checkAt !== undefined && checkDue) {
					delete ii.checking[e.id];
					delete ii.checkStart[e.id];
					delete ii.checkRetryAt[e.id];
					if (e.status === "checking") e.status = "ready";
					emit(state, effects, now, {
						type: "recover",
						entryId: e.id,
						data: { kind: "recheck", commit: e.headCommit, ageMs: now - checkAt },
					});
				}
				const retAt = ii.retireStart[e.id];
				if (ii.retiring[e.id] && retAt !== undefined && now - retAt > STALE_MARKER_MS) {
					delete ii.retiring[e.id];
					delete ii.retireStart[e.id];
					emit(state, effects, now, {
						type: "recover",
						entryId: e.id,
						data: { kind: "reretire", ageMs: now - retAt },
					});
				}
			}
			break;
		}

		case "reset": {
			const trunk = state.trunk;
			const fresh = initialState();
			state.entries = fresh.entries;
			state.stats = fresh.stats;
			state._internal = fresh._internal;
			state.trunk = { repo: trunk.repo, commit: trunk.commit, retiredCount: 0 };
			state.robSize = fresh.robSize;
			emit(state, effects, now, { type: "reset", data: {} });
			break;
		}
	}

	cascade(state, effects, now);
	return { ok: true, state, effects };
}
