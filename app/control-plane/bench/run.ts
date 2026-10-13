// T12 scale benchmark: drives the pure rob.ts state machine in-process.
// Run from app/control-plane/:  node --experimental-strip-types bench/run.ts
//
// Mode (a) "single":  one BufferState holding all N entries (today's one DO).
// Mode (b) "sharded": C independent BufferStates, one per connected component,
//                     events routed by component (the proposed sharding).
//
// Setup state is built directly: entry.create is itself O(N) per call, so
// constructing 100k entries through apply() would add an O(N^2) setup artifact
// unrelated to steady-state per-event cost. The measured phase only uses
// apply() on realistically-shaped states.
//
// Metrics per apply() call: wall time (us), effects emitted, squash broadcasts,
// and "entry scans" = predicate evaluations across entries.find/filter/sort/
// reduce/map measured by a Proxy-wrapped entries array on a deterministic
// replay of the same command stream.

import v8 from "node:v8";
import { performance } from "node:perf_hooks";
import {
	apply,
	initialState,
	type Cmd,
	type Effect,
	type Entry,
	type RobState,
	type SymbolHashes,
} from "../src/rob.ts";

// --- config -----------------------------------------------------------------

const N_LIST = (process.env.BENCH_N ? [Number(process.env.BENCH_N)] : [1_000, 10_000, 100_000]);
// BENCH_HOT=k restricts sharded events to the first k shards (cache-locality control).
const HOT = Number(process.env.BENCH_HOT ?? 0);
const MODES = (process.env.BENCH_MODE ? [process.env.BENCH_MODE] : ["single", "sharded"]) as Array<"single" | "sharded">;
const FAN_OUT = 3;
const DEPTH = 3;
const COMP_SIZE = (FAN_OUT ** (DEPTH + 1) - 1) / (FAN_OUT - 1); // 40
const SEED = 42;
const WARMUP = 150;
const EVENTS_FOR = (n: number) => (n <= 1_000 ? 4_000 : n <= 10_000 ? 2_500 : 1_200);
const SYMS_PER_NODE = 2;

// --- rng --------------------------------------------------------------------

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function pick<T>(rnd: () => number, xs: T[]): T {
	return xs[Math.floor(rnd() * xs.length)];
}

// --- workload model ----------------------------------------------------------

interface GNode {
	g: number;
	comp: number;
	local: number;
	parent: number | null;
	children: number[];
	own: string[]; // symbols this node contributes to its repo's interface
	consumes: string[]; // producer symbols it depends on
}

function buildModel(n: number): { nodes: GNode[]; comps: GNode[][] } {
	const nodes: GNode[] = [];
	const comps: GNode[][] = [];
	const compCount = Math.max(1, Math.floor(n / COMP_SIZE));
	for (let c = 0; c < compCount; c++) {
		const comp: GNode[] = [];
		const frontier: number[] = [];
		const root: GNode = {
			g: nodes.length, comp: c, local: 0, parent: null, children: [],
			own: [], consumes: [],
		};
		for (let s = 0; s < SYMS_PER_NODE; s++) root.own.push(`s${root.g}x${s}`);
		comp.push(root);
		nodes.push(root);
		frontier.push(0);
		let ci = 0;
		while (comp.length < COMP_SIZE) {
			const p = comp[frontier[ci++]];
			for (let k = 0; k < FAN_OUT && comp.length < COMP_SIZE; k++) {
				const node: GNode = {
					g: nodes.length, comp: c, local: comp.length, parent: p.g, children: [],
					own: [], consumes: [],
				};
				for (let s = 0; s < SYMS_PER_NODE; s++) node.own.push(`s${node.g}x${s}`);
				node.consumes.push(p.own[0]);
				if (p.consumes.length > 0) node.consumes.push(p.consumes[node.local % p.consumes.length]);
				p.children.push(node.g);
				comp.push(node);
				nodes.push(node);
				frontier.push(node.local);
			}
		}
		comps.push(comp);
	}
	return { nodes, comps };
}

// --- world (states + harness bookkeeping) -------------------------------------

interface Rec {
	id: string;
	g: number;
	comp: number;
	producerG: number | null;
	repo: string;
	commit: string;
	exports: SymbolHashes;
	own: string[]; // symbols this entry contributes to its repo's interface
	ownHashes: SymbolHashes; // last-pushed hash per own symbol (stable across reforks)
	pending: boolean;
	retired: boolean;
	dependents: number[];
}

// Queued interpreter work. fork.done is resolved lazily at dequeue time: a
// real refork picks up the producer's head when the fork COMPLETES, not when
// the fork effect was emitted — snapshotting at emit time leaves the
// consumer's consumes stale vs the producer's later pushes (phantom diffs).
type QItem = { kind: "fork.done"; entryId: string; repo: string } | { kind: "cmd"; cmd: Cmd };

interface Shard {
	state: RobState;
	queue: QItem[];
	recs: Rec[]; // by creation order (= seq order)
	prods: Rec[]; // recs with dependents
}

interface World {
	mode: "single" | "sharded";
	shards: Shard[];
	recs: Rec[];
	shardOf: (g: number) => number;
}

function exportsFor(nodes: GNode[], g: number): SymbolHashes {
	const out: SymbolHashes = {};
	const p = nodes[g].parent;
	if (p !== null) Object.assign(out, exportsFor(nodes, p));
	for (const s of nodes[g].own) out[s] = `h${g}_${s}`;
	return out;
}

function buildWorld(mode: "single" | "sharded", nodes: GNode[], comps: GNode[][]): World {
	const shards: Shard[] = [];
	const recs: Rec[] = new Array(nodes.length);
	const mkState = (trunkRepo: string, robSize: number): RobState => {
		const s = initialState();
		s.trunk = { repo: trunkRepo, commit: "t0", retiredCount: 0 };
		s.robSize = robSize;
		return s;
	};
	if (mode === "single") {
		shards.push({ state: mkState("arb-trunk", nodes.length + 64), queue: [], recs: [], prods: [] });
	} else {
		for (let c = 0; c < comps.length; c++) {
			shards.push({ state: mkState(`arb-trunk-c${c}`, comps[c].length + 8), queue: [], recs: [], prods: [] });
		}
	}
	for (let c = 0; c < comps.length; c++) {
		const comp = comps[c];
		const shardIdx = mode === "single" ? 0 : c;
		const shard = shards[shardIdx];
		for (let li = 0; li < comp.length; li++) {
			const node = comp[li];
			const seq = shard.state.entries.length + 1;
			const id = `e${seq}`;
			const parent = node.parent === null ? null : recs[node.parent];
			const exports = exportsFor(nodes, node.g);
			const consumes: SymbolHashes = {};
			for (const s of node.consumes) consumes[s] = parent ? parent.exports[s] : "";
			const repo = `arb-e${seq}-l${c}-0`;
			const entry: Entry = {
				id, seq,
				agent: `a${node.g}`,
				lane: `l${c}`,
				status: "speculating",
				repo,
				remote: `https://x/${repo}`,
				producerId: parent ? parent.id : null,
				baseCommit: parent ? parent.commit : "t0",
				headCommit: parent ? parent.commit : "t0",
				exports,
				consumes,
				predicted: [],
				generation: 0,
				diagnosis: null,
				checks: null,
			};
			shard.state.entries.push(entry);
			shard.state._internal.sigs[id] = Object.fromEntries(Object.keys(exports).map((k) => [k, `sig:${k}`]));
			const rec: Rec = {
				id, g: node.g, comp: c, producerG: node.parent,
				repo, commit: entry.headCommit!,
				exports: { ...exports }, own: [...node.own],
				ownHashes: Object.fromEntries(node.own.map((s) => [s, `h${node.g}_${s}`])),
				pending: false, retired: false,
				dependents: node.children,
			};
			recs[node.g] = rec;
			shard.recs.push(rec);
			if (node.children.length > 0) shard.prods.push(rec);
		}
	}
	return {
		mode, shards, recs,
		shardOf: (g) => (mode === "single" ? 0 : recs[g].comp),
	};
}

// --- driver -------------------------------------------------------------------

type Kind = "push.iface" | "push.body" | "ready" | "fork.done" | "check.done" | "retire.done";

interface Timed {
	recIdx: number; // index into recorded stream
	kind: Kind;
	us: number;
	effects: number;
	squashes: number;
}

interface RunResult {
	timed: Timed[];
	recorded: Array<{ shard: number; cmd: Cmd }>;
	serializedBytes: number;
	bytesNoLog: number;
	serMs: number;
	retired: number;
	squashCounts: number[];
	oracleMismatches: number;
	pushChecks: number;
	containmentViolations: number;
}

function descendants(world: World, g: number): Set<number> {
	const out = new Set<number>();
	const stack = [...world.recs[g].dependents];
	while (stack.length) {
		const d = stack.pop()!;
		if (out.has(d)) continue;
		out.add(d);
		stack.push(...world.recs[d].dependents);
	}
	return out;
}

function expectedSquashes(world: World, g: number): number {
	// Machine semantics: the push path skips pending DIRECT dependents
	// (diagnosis-only continue), but squashTree has no pending check — pending
	// deeper descendants are re-squashed. Retired/vetoed are never squashed.
	const out = new Set<number>();
	const stack: number[] = [];
	for (const d of world.recs[g].dependents) {
		const r = world.recs[d];
		if (r.retired || r.pending) continue;
		out.add(d);
		stack.push(d);
	}
	while (stack.length) {
		const d = stack.pop()!;
		for (const c of world.recs[d].dependents) {
			const r = world.recs[c];
			if (r.retired || out.has(c)) continue;
			out.add(c);
			stack.push(c);
		}
	}
	return out.size;
}

// v8.serialize is the closest in-process proxy for the structured-clone cost a
// DO pays on storage.put(STATE_KEY, state) (do.ts:87). Reported per persist for
// the LARGEST single state (single mode: the whole buffer; sharded: one shard).
function serializeMs(world: World): number {
	const sh = world.shards[0];
	const times: number[] = [];
	for (let i = 0; i < 7; i++) {
		const t0 = performance.now();
		v8.serialize(sh.state);
		times.push(performance.now() - t0);
	}
	times.sort((a, b) => a - b);
	return times[3];
}

function run(world: World, events: number, warmup: number, seed: number): RunResult {
	const rnd = mulberry32(seed);
	let hashVer = 0;
	let commitVer = 0;
	let trunkVer = 0;
	const timed: Timed[] = [];
	const recorded: Array<{ shard: number; cmd: Cmd }> = [];
	let oracleMismatches = 0;
	let pushChecks = 0;
	let containmentViolations = 0;
	const squashCounts: number[] = [];
	// per-shard lookup maps kept current by bookkeeping
	const byId: Array<Map<string, Rec>> = world.shards.map((s) => new Map(s.recs.map((r) => [r.id, r])));
	const byRepo: Array<Map<string, Rec>> = world.shards.map((s) => new Map(s.recs.map((r) => [r.repo, r])));

	const livePick = (s: number, wantProd: boolean): Rec | undefined => {
		const pool = wantProd ? world.shards[s].prods : world.shards[s].recs;
		for (let t = 0; t < 8; t++) {
			const r = pick(rnd, pool);
			if (!r.retired && !r.pending) return r;
		}
		return undefined;
	};

	const headRec = (s: number): Rec | undefined => {
		for (const r of world.shards[s].recs) if (!r.retired && !r.pending) return r;
		return undefined;
	};

	const effectsToQueue = (shardIdx: number, effects: Effect[]): void => {
		const shard = world.shards[shardIdx];
		for (const ef of effects) {
			if (ef.type === "fork") {
				const rec = byId[shardIdx].get(ef.entryId);
				if (rec) rec.pending = true;
				shard.queue.push({ kind: "fork.done", entryId: ef.entryId, repo: ef.toRepo });
			} else if (ef.type === "check") {
				shard.queue.push({
					kind: "cmd",
					cmd: {
						type: "check.done", entryId: ef.entryId,
						result: { commit: ef.commit, passed: 3, failed: 0, durationMs: 1, results: [] },
					},
				});
			} else if (ef.type === "retire") {
				shard.queue.push({ kind: "cmd", cmd: { type: "retire.done", entryId: ef.entryId, commit: `trk${++trunkVer}` } });
			}
		}
	};

	const peekKind = (shardIdx: number): Kind => {
		const it = world.shards[shardIdx].queue[0];
		return it.kind === "fork.done" ? "fork.done" : (it.cmd.type as Kind);
	};

	const dequeue = (shardIdx: number): Cmd => {
		const shard = world.shards[shardIdx];
		const it = shard.queue.shift()!;
		if (it.kind === "cmd") return it.cmd;
		const rec = byId[shardIdx].get(it.entryId)!;
		const prod = rec.producerG === null ? undefined : world.recs[rec.producerG];
		return {
			type: "fork.done", entryId: it.entryId, repo: it.repo,
			remote: `https://x/${it.repo}`,
			baseCommit: prod ? prod.commit : (shard.state.trunk.commit ?? "t0"),
			exports: prod ? { ...prod.exports } : {},
		};
	};

	const entryById: Array<Map<string, Entry>> = world.shards.map((s) => new Map(s.state.entries.map((e) => [e.id, e])));
	const isLive = (e: Entry): boolean => e.status !== "retired" && e.status !== "vetoed";

	// Independent oracle, computed from PRE-push entry state and the DAG: a
	// direct dependent is squashed iff it is live, has no fork in flight, and
	// its consumed hashes differ from the pushed exports; every live transitive
	// dependent of a squashed one is squashed with it. If the pushed entry has
	// a fork in flight the machine ignores the push entirely.
	const oracle = (shardIdx: number, rec: Rec, exportsNew: SymbolHashes): Set<string> => {
		const out = new Set<string>();
		const st = world.shards[shardIdx].state;
		if (st._internal.pending[rec.id]) return out;
		const stack: string[] = [];
		for (const d of rec.dependents) {
			const de = entryById[shardIdx].get(world.recs[d].id)!;
			if (!isLive(de) || st._internal.pending[de.id]) continue;
			const diff = Object.keys(de.consumes).some((k) => (exportsNew[k] ?? "") !== de.consumes[k]);
			if (!diff) continue;
			out.add(de.id);
			stack.push(de.id);
		}
		while (stack.length) {
			const id = stack.pop()!;
			for (const c of world.recs[byId[shardIdx].get(id)!.g].dependents) {
				const ce = entryById[shardIdx].get(world.recs[c].id)!;
				if (!isLive(ce) || out.has(ce.id)) continue;
				out.add(ce.id);
				stack.push(ce.id);
			}
		}
		return out;
	};

	const applyOne = (shardIdx: number, cmd: Cmd, kind: Kind): void => {
		const shard = world.shards[shardIdx];
		const recIdx = recorded.length;
		recorded.push({ shard: shardIdx, cmd });
		let pushedRec: Rec | undefined;
		let expectSet: Set<string> | undefined;
		if (cmd.type === "push") {
			pushedRec = byRepo[shardIdx].get(cmd.repo);
			if (pushedRec) expectSet = oracle(shardIdx, pushedRec, cmd.exports ?? {});
		}
		const t0 = performance.now();
		const r = apply(shard.state, cmd, recIdx);
		const us = (performance.now() - t0) * 1000;
		const effects = r.ok ? r.effects : [];
		effectsToQueue(shardIdx, effects);
		if (r.ok) {
			if (cmd.type === "push") {
				const rec = byRepo[shardIdx].get(cmd.repo);
				if (rec) rec.commit = cmd.commit;
			} else if (cmd.type === "fork.done") {
				const rec = byId[shardIdx].get(cmd.entryId);
				if (rec) {
					rec.pending = false;
					byRepo[shardIdx].delete(rec.repo);
					rec.repo = cmd.repo;
					byRepo[shardIdx].set(rec.repo, rec);
					rec.commit = cmd.baseCommit;
					rec.exports = { ...cmd.exports };
				}
			} else if (cmd.type === "retire.done") {
				const rec = byId[shardIdx].get(cmd.entryId);
				if (rec) rec.retired = true;
			}
		}
		const squashedIds = new Set<string>();
		for (const e of effects) {
			if (e.type === "broadcast" && e.event.type === "squash" && e.event.entryId) squashedIds.add(e.event.entryId);
		}
		const squashes = squashedIds.size;
		if (cmd.type === "push" && r.ok && pushedRec && expectSet) {
			pushChecks++;
			const desc = descendants(world, pushedRec.g);
			let outside = 0;
			for (const id of squashedIds) {
				const sq = byId[shardIdx].get(id);
				if (sq && !desc.has(sq.g)) outside++;
			}
			containmentViolations += outside;
			let same = squashedIds.size === expectSet.size;
			if (same) for (const id of expectSet) if (!squashedIds.has(id)) { same = false; break; }
			if (!same) oracleMismatches++;
			if (kind === "push.iface" && squashes > 0) {
				squashCounts.push(squashes);
			}
		}
		if (recIdx >= warmup) timed.push({ recIdx, kind, us, effects: effects.length, squashes });
	};

	for (let i = 0; i < events + warmup; i++) {
		const s = world.mode === "single" ? 0 : Math.floor(rnd() * Math.min(HOT || world.shards.length, world.shards.length));
		const shard = world.shards[s];
		const roll = rnd();

		// Push exports for `rec`. A re-forked entry's repo holds only its
		// producer's content until the agent re-pushes; a real agent restores
		// its own symbols then, with the same interface it had before (body)
		// or a changed one (iface). ownHashes tracks that interface.
		const pushExports = (rec: Rec, iface: boolean): SymbolHashes => {
			for (const sym of rec.own) {
				if (iface) rec.ownHashes[sym] = `v${++hashVer}`;
				rec.exports[sym] = rec.ownHashes[sym];
			}
			if (iface) {
				for (const sym of Object.keys(rec.exports)) rec.exports[sym] = `v${++hashVer}`;
			} else {
				rec.exports[`pad${rec.g}_${hashVer % 7}`] = `n${++hashVer}`;
			}
			return { ...rec.exports };
		};

		if (shard.queue.length > 0 && roll < 0.55) {
			const k = peekKind(s);
			applyOne(s, dequeue(s), k);
		} else if (roll < 0.40) {
			const rec = livePick(s, false) ?? headRec(s);
			if (!rec) continue;
			applyOne(s, { type: "push", repo: rec.repo, commit: `c${++commitVer}`, exports: pushExports(rec, false) }, "push.body");
		} else if (roll < 0.62) {
			const rec = livePick(s, true);
			const exp = rec ? expectedSquashes(world, rec.g) : 0;
			if (rec && exp > 0) {
				applyOne(s, { type: "push", repo: rec.repo, commit: `c${++commitVer}`, exports: pushExports(rec, true) }, "push.iface");
			} else {
				const rec2 = livePick(s, false) ?? headRec(s);
				if (!rec2) continue;
				applyOne(s, { type: "push", repo: rec2.repo, commit: `c${++commitVer}`, exports: pushExports(rec2, false) }, "push.body");
			}
		} else if (roll < 0.85) {
			const rec = rnd() < 0.7 ? headRec(s) ?? livePick(s, false) : livePick(s, false);
			if (!rec) continue;
			applyOne(s, { type: "entry.ready", entryId: rec.id, commit: rec.commit }, "ready");
		} else if (shard.queue.length > 0) {
			const k = peekKind(s);
			applyOne(s, dequeue(s), k);
		} else {
			const rec = livePick(s, false);
			if (!rec) continue;
			applyOne(s, { type: "push", repo: rec.repo, commit: `c${++commitVer}`, exports: pushExports(rec, false) }, "push.body");
		}
	}

	return {
		timed, recorded,
		serializedBytes: world.shards.reduce((m, sh) => m + JSON.stringify(sh.state).length, 0),
		bytesNoLog: world.shards.reduce((m, sh) => m + JSON.stringify({ ...sh.state, _internal: { ...sh.state._internal, eventLog: [] } }).length, 0),
		serMs: serializeMs(world),
		retired: world.recs.filter((r) => r.retired).length,
		squashCounts, oracleMismatches, pushChecks, containmentViolations,
	};
}

// --- entry-scan instrumentation ------------------------------------------------
// Wraps each state's entries array in a Proxy that counts predicate evaluations
// (find/filter/sort/reduce/map callbacks) during apply(). This measures the
// linear-scan cost inside the state machine without editing rob.ts.

let activeScanCounter: { n: number } | null = null;

// Counting wrapper applied recursively: filter()/map() results are re-wrapped
// so that e.g. head()'s `.filter(live).sort(cmp)` counts both the filter scan
// AND the sort comparisons.
function wrapArray(t: Entry[]): Entry[] {
	const counted = (...a: unknown[]) => {
		if (activeScanCounter) activeScanCounter.n++;
	};
	void counted;
	return new Proxy(t, {
		get(tt, p, recv) {
			if (p === "find" || p === "forEach" || p === "some" || p === "every") {
				return (cb: (...a: unknown[]) => unknown, thisArg?: unknown) =>
					(Array.prototype[p] as Function).call(
						tt,
						(...a: unknown[]) => {
							if (activeScanCounter) activeScanCounter.n++;
							return cb(...a);
						},
						thisArg,
					);
			}
			if (p === "filter" || p === "map") {
				return (cb: (...a: unknown[]) => unknown, thisArg?: unknown) =>
					wrapArray(
						(Array.prototype[p] as Function).call(
							tt,
							(...a: unknown[]) => {
								if (activeScanCounter) activeScanCounter.n++;
								return cb(...a);
							},
							thisArg,
						),
					);
			}
			if (p === "reduce") {
				return (cb: (...a: unknown[]) => unknown, init?: unknown) =>
					(Array.prototype.reduce as Function).call(
						tt,
						(...a: unknown[]) => {
							if (activeScanCounter) activeScanCounter.n++;
							return cb(...a);
						},
						init,
					);
			}
			if (p === "sort") {
				return (cmp?: (a: Entry, b: Entry) => number) =>
					wrapArray(
						Array.prototype.sort.call(
							tt,
							cmp
								? (a: Entry, b: Entry) => {
										if (activeScanCounter) activeScanCounter.n++;
										return cmp(a, b);
									}
								: undefined,
						),
					);
			}
			const v = Reflect.get(tt, p, recv);
			return typeof v === "function" ? (v as Function).bind(tt) : v;
		},
	});
}

function wrapEntries(state: RobState): void {
	state.entries = wrapArray(state.entries);
}

function replayScans(world: World, recorded: Array<{ shard: number; cmd: Cmd }>, limit: number): number[] {
	for (const sh of world.shards) wrapEntries(sh.state);
	const scans: number[] = [];
	const n = Math.min(limit, recorded.length);
	for (let i = 0; i < n; i++) {
		const counter = { n: 0 };
		activeScanCounter = counter;
		apply(world.shards[recorded[i].shard].state, recorded[i].cmd, i);
		activeScanCounter = null;
		scans.push(counter.n);
	}
	return scans;
}

// --- stats --------------------------------------------------------------------

function summarize(xs: number[]): { n: number; med: number; p95: number; mean: number; max: number } {
	const s = [...xs].sort((a, b) => a - b);
	const q = (f: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))] : 0);
	return { n: s.length, med: q(0.5), p95: q(0.95), mean: s.reduce((a, b) => a + b, 0) / Math.max(1, s.length), max: s.length ? s[s.length - 1] : 0 };
}

// --- main ---------------------------------------------------------------------

const { nodes, comps } = buildModel(Math.max(...N_LIST));
console.log(`model: ${nodes.length} entries max, ${comps.length} comps max, compSize=${COMP_SIZE} (fan-out=${FAN_OUT}, depth<=${DEPTH})`);
console.log(`runtime: node ${process.version} ${process.platform}/${process.arch}`);
console.log("");

interface Out {
	mode: string; n: number; c: number;
	byKind: Array<{ kind: string; cnt: number; medUs: number; p95Us: number; meanEff: number; meanScan: number; maxScan: number }>;
	all: { medUs: number; p95Us: number };
	headUs: number; findUs: number; pushChecks: number; bytes: number; bytesNoLog: number; serMs: number; retired: number; mismatches: number; containment: number; squashDist: ReturnType<typeof summarize>;
	squashHist: Map<number, number>;
}
const outs: Out[] = [];

for (const n of N_LIST) {
	const subNodes = nodes.slice(0, n);
	const compCount = Math.max(1, Math.floor(n / COMP_SIZE));
	const subComps = comps.slice(0, compCount);

	for (const mode of MODES) {
		const world = buildWorld(mode, subNodes, subComps);
		const res = run(world, EVENTS_FOR(n), WARMUP, SEED + n);

		// Isolated micro-measurements on the final state (same code shape as
		// rob.ts head() and find()): median of 34 runs after 3 warmups, one shard.
		const probe = world.shards[0].state;
		const med = (f: () => void): number => {
			f(); f(); f();
			const ts: number[] = [];
			for (let i = 0; i < 34; i++) { const t0 = performance.now(); f(); ts.push((performance.now() - t0) * 1000); }
			ts.sort((a, b) => a - b);
			return ts[Math.floor(ts.length / 2)];
		};
		const liveE = (e: Entry) => e.status !== "retired" && e.status !== "vetoed";
		const lastId = probe.entries[probe.entries.length - 1].id;
		const headUs = med(() => { probe.entries.filter(liveE).sort((a, b) => a.seq - b.seq)[0]; });
		const findUs = med(() => { probe.entries.find((e) => e.id === lastId); });

		// deterministic replay on a fresh world for entry-scan counts
		const world2 = buildWorld(mode, subNodes, subComps);
		const scans = replayScans(world2, res.recorded, res.recorded.length);
		const scanFor = (t: Timed): number => (t.recIdx < scans.length ? scans[t.recIdx] : -1);
		const scanned = res.timed.filter((t) => scanFor(t) >= 0);

		const byKind: Out["byKind"] = [];
		const kinds = new Map<Kind, Timed[]>();
		for (const t of res.timed) {
			const a = kinds.get(t.kind) ?? [];
			a.push(t);
			kinds.set(t.kind, a);
		}
		for (const [kind, ts] of kinds) {
			const us = summarize(ts.map((t) => t.us));
			const sk = summarize(ts.map(scanFor).filter((x) => x >= 0));
			byKind.push({
				kind, cnt: ts.length, medUs: us.med, p95Us: us.p95,
				meanEff: ts.reduce((a, t) => a + t.effects, 0) / ts.length,
				meanScan: sk.mean, maxScan: sk.max,
			});
		}
		const all = summarize(res.timed.map((t) => t.us));
		const allScan = summarize(scanned.map(scanFor));
		byKind.push({ kind: "ALL", cnt: res.timed.length, medUs: all.med, p95Us: all.p95, meanEff: res.timed.reduce((a, t) => a + t.effects, 0) / Math.max(1, res.timed.length), meanScan: allScan.mean, maxScan: allScan.max });

		const hist = new Map<number, number>();
		for (const s of res.squashCounts) hist.set(s, (hist.get(s) ?? 0) + 1);
		outs.push({
			mode, n, c: mode === "single" ? 1 : compCount, byKind, all,
			bytes: res.serializedBytes, bytesNoLog: res.bytesNoLog, serMs: res.serMs, headUs, findUs, retired: res.retired,
			mismatches: res.oracleMismatches, pushChecks: res.pushChecks, containment: res.containmentViolations, squashDist: summarize(res.squashCounts),
			squashHist: hist,
		});
		console.log(`done ${mode} N=${n}: ${res.timed.length} timed, retired=${res.retired}, state=${(res.serializedBytes / 1e6).toFixed(2)}MB, oracle_mismatch=${res.oracleMismatches}/${res.pushChecks}, containment_violations=${res.containmentViolations}`);
	}
}

console.log("\n=== per-event cost ===");
console.log("mode     N        C     kind           n     med_us    p95_us   mean_eff  mean_scan  max_scan");
for (const o of outs) {
	for (const k of o.byKind) {
		console.log(
			`${o.mode.padEnd(8)} ${String(o.n).padEnd(8)} ${String(o.c).padEnd(5)} ${k.kind.padEnd(13)} ${String(k.cnt).padEnd(6)} ${k.medUs.toFixed(1).padStart(9)} ${k.p95Us.toFixed(1).padStart(9)} ${k.meanEff.toFixed(2).padStart(9)} ${(k.cnt && Number.isFinite(k.meanScan) ? k.meanScan.toFixed(0) : '-').padStart(10)} ${String(k.maxScan).padStart(9)}`,
		);
	}
}

console.log("\n=== squash fan-out (squashed entries per interface push) ===");
for (const o of outs) {
	const hist = [...o.squashHist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join(" ");
	console.log(`${o.mode} N=${o.n}: n=${o.squashDist.n} med=${o.squashDist.med} mean=${o.squashDist.mean.toFixed(1)} p95=${o.squashDist.p95} max=${o.squashDist.max} oracle_mismatches=${o.mismatches}/${o.pushChecks} pushes containment_violations=${o.containment}`);
	console.log(`  dist(count:freq) ${hist}`);
}
console.log("\n=== serialized state size (JSON) and v8.serialize time of one state ===");
for (const o of outs) {
	console.log(`${o.mode} N=${o.n}: ${(o.bytes / 1e6).toFixed(2)} MB total, ${(o.bytesNoLog / 1e6).toFixed(2)} MB without eventLog, ${o.c} state(s), v8.serialize(one state)=${o.serMs.toFixed(2)} ms`);
}

console.log("\n=== isolated cost of rob.ts head() shape (filter(live).sort(seq)[0]) and find-by-id (worst case) on one state ===");
for (const o of outs) {
	console.log(`${o.mode} N=${o.n}: states hold ${o.mode === "single" ? o.n : COMP_SIZE} entries each; head()=${o.headUs.toFixed(1)} us, find(last)=${o.findUs.toFixed(1)} us`);
}
