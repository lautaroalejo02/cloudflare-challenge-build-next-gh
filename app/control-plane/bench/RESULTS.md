# T12 scale benchmark: reorder-buffer coordination cost

Raw output of the run below: `bench/out.txt`. Reproduce (about 2 minutes):
`cd app/control-plane && node --experimental-strip-types bench/run.ts`
(`BENCH_N=1000` limits to one size; `BENCH_MODE=single|sharded`; `BENCH_HOT=k` routes sharded events to k shards only.)

## Setup
- Subject: the pure `apply()` in `src/rob.ts` as of this run (value-prediction fields present). Line numbers below are for that revision; the file was being edited concurrently, so re-check them.
- Components: complete ternary trees (fan-out 3, depth 3, 40 entries each), C = N/40 components: N = 1,000 / 10,000 / 100,000 gives C = 25 / 250 / 2,500.
- State is built directly (not through `entry.create`, which is itself O(N)); only the event stream is measured. `robSize` is set above N.
- Event stream (seeded, deterministic): interface-changing pushes, body-only pushes (early cutoff), `entry.ready`, and interpreter-style `fork.done`, `check.done`, `retire.done` fed back from emitted effects. 4,000 / 2,500 / 1,200 timed events per mode (150 warmup). Not exercised: `entry.create`, veto, `retire.planned`, `retire.overlap`.
- Mode (a) `single`: one state with all N entries. Mode (b) `sharded`: C states of 40 entries, each event routed to its component.
- "scan" is the number of callback evaluations in `entries.find/filter/map/sort/reduce` per `apply()`, counted on a deterministic replay through a Proxy (not in the timed run).
- Hardware: AMD Ryzen 5 7530U (12 threads), 15.4 GiB, Windows 11, Node v22.15.1 x64.

## Per-event cost (all event kinds mixed; median / p95 in microseconds)
| N | single med | single p95 | single scan (mean) | sharded med | sharded p95 | sharded scan (mean) |
|---|---|---|---|---|---|---|
| 1,000 | 29.6 | 92.3 | 3,085 | 2.9 | 11.9 | 116 |
| 10,000 | 393.6 | 1,462.6 | 31,290 | 6.2 | 21.0 | 134 |
| 100,000 | 16,208 | 55,220 | 304,219 | 17.2 | 48.3 | 187 |

Selected kinds, single mode (median us): `check.done` 26.9 / 319 / 13,776; `push.iface` 97 / 1,809 / 59,109 (N = 1k / 10k / 100k). Scans for `check.done` are exactly 2N (1,999 / 19,999 / 199,999+).
Effects per event (mean, all kinds): 3.1 at N=1k, 3.2 at 10k, 3.1 at 100k in single mode. They track fan-out, not N.

## Does per-event cost grow with N in a single buffer? Yes, about linearly or worse
Median rose 13x for 10x entries (1k to 10k) and 41x for the next 10x (10k to 100k). The second step is more than linear; I did not isolate why (likely allocation/GC of 100k-element temporaries plus cache misses). Cost is paid by every event, including ones that touch two entries.

Culprits (`src/rob.ts`):
- `head()` at 239-240, `entries.filter(live).sort(seq)[0]`, called by `cascade()` at 338, which runs at the end of EVERY `apply()` (844). This is the 2N scan on `check.done`/`ready`/`fork.done`. The same code shape isolated on the 100k state: 15.5 ms (an earlier run measured 25.5 ms; GC-noisy), against 13.8 ms for the whole `check.done` event.
- `squashTree` 298 and the push loop 549: `entries.filter(producerId === ...)` is a full scan per squashed node, so a push squashing k entries costs about (k+1)*N. Max observed 4.28M scans for one push at N=100k.
- `find()` 230-231 (used at 384, 449, 513, 657, ...), push lookup by repo at 499, and the pending reverse lookup `Object.keys(pending).find` at 501. `find(last)` isolated at 100k: 12.3 ms.
- `entry.create` 380 (filter) and 390 (reduce for max seq): O(N), not measured in the event stream.

Recommended fix (not applied; not measured as a patch):
- `head()`: entries are appended in seq order and never return from retired/vetoed, so keep a monotone cursor to the first live entry (O(1) amortized).
- Keep `Map<id,Entry>`, `Map<repo,Entry>`, `Map<producerId,Entry[]>` and a pending repo-to-id map; keep an active counter and a `nextSeq` counter.
- Persistence: `do.ts:87` writes the whole state on every `persist()`. `v8.serialize` of one state: 3.2 ms / 45 ms / 634 ms at N = 1k / 10k / 100k. Write per-entry keys or deltas instead.

## Per-component sharding (mode b)
Work per event is flat in N: scans 116 / 134 / 187 mean (80 for `check.done` at every N, i.e. 2 x 40). Median wall time still rose 2.9 / 6.2 / 17.2 us. Control: `BENCH_MODE=sharded BENCH_HOT=25 BENCH_N=100000` (events confined to 25 shards inside the same 2,500-state heap) gave median 3.8 us, p95 16.3 us. So the rise is memory locality of the one-process simulation, not algorithmic growth. This was a single control run.
`v8.serialize` of one shard: 0.30 / 0.13 / 0.09 ms.

## State size (JSON)
| N | single | sharded total | sharded without eventLog |
|---|---|---|---|
| 1,000 | 0.65 MB | 1.45 MB | 0.64 MB |
| 10,000 | 6.93 MB | 8.69 MB | 7.29 MB |
| 100,000 | 74.4 MB | 75.5 MB | 74.2 MB |

About 740 bytes per entry. The 200-event `eventLog` adds a fixed cost per shard (about 30 KB). I did not verify Durable Object storage value limits in this run; check them, since the single-DO state is already 0.65 MB at N=1,000 and is written as one value.

## Squash fan-out and containment
- Every push (3,803 across all runs, both modes) was checked against an independent oracle built from the DAG and pre-push `consumes`: squashed set = live, non-pending direct dependents whose consumed hashes changed, plus all live transitive dependents of those. Mismatches: 0. Squashes outside the pushed entry's transitive dependents: 0.
- Interface-push squash counts are subtree sizes: 3 (depth-2 producers), 12 (depth-1), 39 (root). Single mode: N=100k gave {3: 71, 12: 21, 39: 7}, mean 7.5, p95 39. Other values (1, 2, 4, 8, 13, 26) appear when retired entries shrink the live subtree; counts above 39 never occurred. Fan-out is bounded by the dependency subtree and independent of N.
- Body-only pushes are part of the same 3,803 checks and matched the oracle too.

## Scale story (for the README)
In a synthetic, in-process benchmark of the pure state machine (no network, no Durable Object I/O), an interface-changing push squashed exactly the transitive dependents whose consumed hashes had changed (3,803 pushes checked, 0 mismatches, none outside the dependency subtree), with 3 to 39 squashes per push in 40-entry components. Today's single-buffer implementation does not yet scale with the touched edges: its median per-event time rose from 30 us at 1,000 entries to 394 us at 10,000 and 16 ms at 100,000, because several steps scan the whole entry list on every event. Splitting disconnected components into separate buffers held the work per event flat (about 80 to 190 entry-predicate evaluations at every N, median 3 to 17 us), which supports the sharding claim for the state machine itself; cross-component dependencies, routing, and real Durable Object latency were not measured.

## Caveats
- Synthetic uniform workload; uniform event routing; complete ternary trees only (no cross-component edges, no shared producers).
- Timings are single-process wall clock on a laptop with GC noise; the 10k and 100k single-mode figures come from 2,500 and 1,200 events, and p95 at 100k comes from only dozens of events per kind.
- Different kinds appear in different proportions per mode and size, so compare the "ALL" rows loosely and the per-kind rows precisely.
- Sharded runs retire fewer entries at large N because each shard has its own head and each receives few events.

---

# T14 rerun: same benchmark after index maps landed in `src/rob.ts`

Same harness, same workload, same machine, ~2 minute run. `src/rob.ts` now
maintains `RobIndexes` (`byId`, `byRepo`, `childrenOf`, `pendingRepo`,
`headCursor`, `active`, `lastSeq`) inside `_internal`, persisted as plain
JSON objects and rebuilt lazily when `entries.length` changed outside the
machine. `head()` is a monotone cursor, `find()` is `byId` + binary search on
the seq-sorted array, the squash/push child scans go through `childrenOf`,
and `entry.create` splices into sorted position instead of pushing.

## Per-event cost after indexes (median / p95 us)
| N | single med | single p95 | single scan (mean) | sharded med | sharded p95 | sharded scan (mean) |
|---|---|---|---|---|---|---|
| 1,000 | 2.1 | 19.3 | 0 | 2.1 | 12.0 | 0 |
| 10,000 | 2.4 | 18.8 | 0 | 3.4 | 51.0 | 2 |
| 100,000 | 2.7 | 23.3 | 0 | 62.5 | 112.7 | 29 |

Before/after for the single-buffer ALL median: 29.6 -> 2.1 us (N=1k),
393.6 -> 2.4 us (N=10k), 16,208 -> 2.7 us (N=100k). Scans per event went
from ~2N to ~0 in single mode: the linear scans the T12 table blamed are
gone. Per-kind medians at N=100k single: `check.done` 1.5, `push.iface`
25.7, `retire.done` 1.1 (all us).

Squash fan-out is unchanged (oracle: 0 mismatches, 0 containment violations
across all 3,803 pushed events in this run too); the `squashTree` work now
scales with the dependency subtree only.

## What still scales badly in single mode, and what does not
- Per-event CPU is now flat in N (~2-3 us medians at every N). The residual
  20-145 us on `push.iface` is the cascade/fan-out work itself, which is
  proportional to the squash count (3-39 in this workload), not N.
- State size and (de)serialization are NOT flat: the single state is
  0.69 / 7.43 / 80.07 MB and `v8.serialize` of it costs
  3.7 / 52 / 732 ms at N = 1k / 10k / 100k, on every `persist()`. Sharded
  states serialize in 0.24 / 0.14 / 0.08 ms each. This, not apply() CPU, is
  now the single-DO bottleneck — and the reason T14 still shards.
- Sharded medians at N=100k rose to 62.5 us (vs 17.2 before indexes). Same
  caveat as before applies: one-process simulation locality, not algorithmic
  growth (mean scans 29 in 40-entry shards; the residual scan is the small
  `filter(live)` on the ~40-entry children list). The `BENCH_HOT` control was
  not re-run this time.
- `head()`/`find(last)` isolated on the built states: single 23.1/16.5 us
  (1k), 294.6/141.9 us (10k), 14,736/10,044 us (100k) vs sharded ~1/0.5 us —
  but in the new code these helper shapes only run inside `ensureIdx`
  rebuilds, not per event.

## Updated scale story
Index maps removed the O(N) per-event cost from the pure machine: a single
buffer now processes events in ~2-3 us median at every measured N, and every
push still squashed exactly the oracle's dependent set (0/3,803 mismatches).
What does not scale is the single DO's serialized state: 80 MB / ~0.7 s
serialize at N=100k. One DO per connected component bounds both the CPU and
the persisted state by component size (40-entry shards serialize in <0.25 ms).
Cross-component dependencies, routing overhead, and real Durable Object
latency remain unmeasured — see the live-scenario numbers in NOTES.md.

---

# V2 (same machine comparison)

Orchestrator's measurement on 2026-10-13, same machine and same harness,
`BENCH_MODE=single` at N = 100,000 (`odd/tasks/arb-v2.md`, V3b entry):

| build | median per event | p95 |
|---|---|---|
| v1 `a634b36` | 10.3 µs | 78.3 µs |
| v2 (current) | 19.1 µs | 79.7 µs |

About 1.9x the v1 median with p95 essentially flat — the cost of the V2
fields and fork bookkeeping inside `apply()`.

The 2.1–2.7 µs medians in the T14 rerun above came from an earlier, quieter
run on v1-era code; they must not be compared directly to this table. Quote
the same-machine comparison for v2, not 2.7 µs.
