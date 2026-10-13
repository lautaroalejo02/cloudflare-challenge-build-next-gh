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
	reason: "interface-changed" | "producer-vetoed" | "producer-squashed" | "trunk-overlap" | "prediction-miss";
	changed: Array<{
		symbol: string;
		oldHash: string;
		newHash: string;
		oldSignature: string;
		newSignature: string;
	}>;
	producerCommit: string;
}

export interface CheckResult {
	commit: string;
	passed: number;
	failed: number;
	durationMs: number;
	results: Array<{ name: string; ok: boolean; error?: string }>;
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
		| "reset";
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
	/** entryId -> commit a check is running against. */
	checking: Record<string, string>;
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
	/** Bounded event log for debugging. */
	eventLog: ArbEvent[];
	/** Hot-path indexes (T14); maintained by apply(), rebuilt when stale. */
	idx?: RobIndexes;
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
		},
		_internal: {
			sigs: {},
			pending: {},
			checking: {},
			retiring: {},
			retireStrikes: {},
			retireStart: {},
			seenPushes: [],
			repoAlias: {},
			predConsumed: {},
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
			stub?: { exports: SymbolHashes; sigs: SymbolSignatures };
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
			sigs?: SymbolSignatures;
	  }
	| { type: "push"; repo: string; commit: string; exports?: SymbolHashes; sigs?: SymbolSignatures }
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
	| { type: "reset" };

export type Effect =
	| { type: "fork"; entryId: string; fromRepo: string; toRepo: string }
	| { type: "token"; entryId: string; repo: string }
	| { type: "check"; entryId: string; repo: string; commit: string }
	| { type: "retire"; entryId: string; fromRepo: string; commit: string; baseCommit: string; toRepo: string; branch: string }
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

/** Rebuild every index from `entries` + `pending` (re-sorts entries by seq).
 * Called on first apply after load/persist-restore, and whenever `entries`
 * changed size outside the machine. */
export function rebuildIndexes(state: RobState): RobIndexes {
	const entries = state.entries;
	entries.sort((a, b) => a.seq - b.seq);
	const i = emptyIndexes();
	for (const e of entries) {
		i.byId[e.id] = e.seq;
		if (e.repo) i.byRepo[e.repo] = e.id;
		if (e.producerId) (i.childrenOf[e.producerId] ??= []).push(e.id);
		if (e.status !== "retired") i.active += 1;
		if (e.seq > i.lastSeq) i.lastSeq = e.seq;
	}
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

function setPending(state: RobState, id: string, repo: string): void {
	state._internal.pending[id] = repo;
	idx(state).pendingRepo[repo] = id;
}

function clearPending(state: RobState, id: string): void {
	const repo = state._internal.pending[id];
	if (repo !== undefined) delete idx(state).pendingRepo[repo];
	delete state._internal.pending[id];
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

function forkEffect(state: RobState, effects: Effect[], e: Entry, fromRepo: string): string {
	const toRepo = `arb-e${e.seq}-${e.lane}-${e.generation}`;
	setPending(state, e.id, toRepo);
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
	for (const c of children(state, producer.id).filter(live)) {
		// Rebase target for THIS dependent.
		let fromRepo = baseRepo;
		let newExports = baseExports;
		let newSigs = baseSigs;
		if (reason === "producer-squashed") {
			// Refork from the parent's new (in-flight) fork.
			fromRepo = state._internal.pending[producer.id] ?? producer.repo;
		}
		const oldSigs = state._internal.sigs[c.id] ?? {};
		const changed = consumedDiff(c.consumes, newExports, oldSigs, newSigs);
		c.generation += 1;
		c.status = "squashed";
		c.diagnosis = { reason, changed, producerCommit };
		if (reparentTo !== undefined) {
			reparent(state, c.id, c.producerId, reparentTo);
			c.producerId = reparentTo;
		}
		state.stats.squashes += 1;
		const newRepo = forkEffect(state, effects, c, fromRepo);
		emit(state, effects, now, {
			type: "squash",
			entryId: c.id,
			data: { reason, changed, generation: c.generation, repo: newRepo },
		});
		// Its own dependents collapse onto its new fork.
		squashTree(
			state,
			effects,
			now,
			c,
			"producer-squashed",
			newRepo,
			newExports,
			newSigs,
			producerCommit,
			undefined,
		);
	}
}

/** Component-level retry bound for exhausted atomic-retire cycles (T17).
 * Below it the next cascade re-fires retirement automatically; at it the
 * entry parks at `failed` until a push or a fresh `entry.ready` resets the
 * strike count. */
export const MAX_RETIRE_CYCLES = 3;

/** Advance the retirement pipeline: the head entry checks, then retires. */
function cascade(state: RobState, effects: Effect[], now: number): void {
	const h = head(state);
	if (!h || state._internal.pending[h.id]) return;
	if (h.status === "ready" && !state._internal.checking[h.id]) {
		if (!h.checks || h.checks.commit !== h.headCommit) {
			h.status = "checking";
			state._internal.checking[h.id] = h.headCommit!;
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
			if (cmd.stub) state._internal.sigs[id] = { ...cmd.stub.sigs };
			const fromRepo = producer ? producer.repo : state.trunk.repo;
			const repo = forkEffect(state, effects, entry, fromRepo);
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
					predicted: entry.predicted,
				},
			});
			break;
		}

		case "fork.done": {
			const e = find(state, cmd.entryId);
			if (!e) return err(404, `entry ${cmd.entryId} not found`);
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
			// A stubbed producer's fork carries its pre-push base: keep the
			// declared (predicted) hashes and signatures for predicted symbols
			// until the first real push resolves them against reality.
			if (e.predicted.length) {
				const keep: SymbolHashes = {};
				const keepSig: SymbolSignatures = {};
				const curSigs = state._internal.sigs[e.id] ?? {};
				for (const sym of e.predicted) {
					keep[sym] = e.exports[sym];
					keepSig[sym] = curSigs[sym] ?? "";
				}
				e.exports = { ...cmd.exports, ...keep };
				state._internal.sigs[e.id] = { ...(cmd.sigs ?? {}), ...keepSig };
			} else {
				e.exports = cmd.exports;
				state._internal.sigs[e.id] = cmd.sigs ?? {};
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
			if (cmd.sigs) state._internal.sigs[target.id] = cmd.sigs;
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
						state.stats.squashes += 1;
						const newRepo = forkEffect(state, effects, c, target.repo);
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
				state.stats.squashes += 1;
				const newRepo = forkEffect(state, effects, c, target.repo);
				emit(state, effects, now, {
					type: "squash",
					entryId: c.id,
					data: { reason: "interface-changed", changed, generation: c.generation, repo: newRepo },
				});
				squashTree(state, effects, now, c, "producer-squashed", newRepo, exports, sigs, cmd.commit, undefined);
			}
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
			e.status = "ready";
			emit(state, effects, now, { type: "ready", entryId: e.id, data: { commit: cmd.commit } });
			break;
		}

		case "check.done": {
			const e = find(state, cmd.entryId);
			if (!e) return err(404, `entry ${cmd.entryId} not found`);
			delete state._internal.checking[e.id];
			state.stats.checksRun += 1;
			// Checks are issued from "ready"/"checking" (head). Any other status
			// means the check is stale — applying it could resurrect a
			// retired/squashed entry (observed: a head check completing after
			// retirement flipped e3 back to ready and triggered a phantom
			// trunk-overlap loop).
			if (e.status !== "ready" && e.status !== "checking") break;
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
			state.stats.squashes += 1;
			const newRepo = forkEffect(state, effects, e, fromRepo);
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
			if (cmd.entryCommit && e.headCommit !== cmd.entryCommit) break; // stale: head moved mid-retire
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
			e.status = "vetoed";
			clearPending(state, e.id);
			delete state._internal.checking[e.id];
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

		case "reset": {
			const trunk = state.trunk;
			const robSize = state.robSize;
			const fresh = initialState();
			state.entries = fresh.entries;
			state.stats = fresh.stats;
			state._internal = fresh._internal;
			state.trunk = { repo: trunk.repo, commit: trunk.commit, retiredCount: 0 };
			state.robSize = robSize;
			emit(state, effects, now, { type: "reset", data: {} });
			break;
		}
	}

	cascade(state, effects, now);
	return { ok: true, state, effects };
}
