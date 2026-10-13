# ARB architecture

Deep design notes for the Agent Reorder Buffer. Contracts and data-model
types live in `app/CONTRACTS.md`; this document explains how the pieces move.

## Components and where the logic lives

| Piece | Location | Role |
|---|---|---|
| `rob.ts` | `app/control-plane/src/rob.ts` | Pure reorder-buffer state machine. `apply(state, cmd, now)` returns `{state, effects}`; no Cloudflare imports, unit-tested with `node:test` (33 cases incl. splice decision, git-level retire and declared-stub prediction tests). |
| Ports | `app/control-plane/src/ports.ts` | `ArtifactsPort` (real, wraps the `ARTIFACTS` binding), `HasherPort`, `CheckerPort`, `RetirerPort` — the state machine's only I/O surface, so integration swaps interfaces not logic. |
| DO | `app/control-plane/src/do.ts` | `ReorderBuffer` Durable Object, one instance `idFromName("default-t11")` (the name is bumped on deploy to escape alarmed-object version pinning — `app/control-plane/NOTES.md`). Executes effects, persists state, broadcasts events over hibernating WebSockets, runs the alarm poll. |
| Worker | `app/control-plane/src/index.ts` | `/api/*` → DO; queue consumer → `onPush`; everything else → static assets. |
| Hasher | `app/hasher/` | `hashInterface(files)` — web-tree-sitter + TypeScript grammar WASM, normalizes signatures so formatting/comments/bodies/reordering never move a hash. |
| Checker | `app/checker/` | `runChecks(env, repo, commit)` — walks the commit tree, strips TS (sucrase), loads a Dynamic Worker via the Worker Loader, calls each `tests/**/*.test.ts` module's `run()`. |
| Retirer | `app/control-plane/src/retire.ts` + pure `src/splice.ts` (grown out of `app/retirer-spike`) | isomorphic-git on `MemFs` inside the DO: fast-forward when the trunk head is an ancestor of the entry head; otherwise the path-disjoint splice — candidate commit pushed to `refs/heads/arb-candidate` on the trunk repo, checked, then `main` moved via `moveBranch`. `P ∩ Q ≠ ∅` → `trunk-overlap` squash. |
| Dashboard | `app/dashboard/` | Static UI; folds `ArbEvent`s into a `BufferState`-shaped model (`state.js`, DOM-free, Node-testable). |
| Demo | `app/demo/` | Fixture repo, three scripted agents, `scenario.ts` runner, and `mock-server.ts` (local control-plane stand-in for offline tests). |

The push path, end to end:

```
agent git push → Artifacts repo.pushed → Queue arb-push-events
  → Worker consumer → ReorderBuffer DO
  → readTree(new commit) → hashInterface(files)
  → apply(state, push cmd) → effects {squash+refork | nothing (early cutoff)}
  → broadcast ArbEvent to dashboards
```

Interface hashing happens in the DO *between* `apply` calls (queue/alarm →
`readTree` → `hashInterface` → `push` command), which keeps `rob.ts` pure.

## The state machine

`Entry.status` has seven values (`app/CONTRACTS.md`). Transitions, as
implemented in `rob.ts` and documented in `app/control-plane/NOTES.md`:

```
                 ┌─────────────── entry.created ───────────────┐
                 ▼                                             │
           speculating ──push──▶ speculating (headCommit updated)
                 │                                             │
                 │ POST /ready, commit == headCommit           │
                 ▼                                             │
               ready ──at head──▶ checking ──pass──▶ retired   │
                 ▲                  │                          │
                 │                  └──fail──▶ failed          │
                 │                                             │
   squashed ◀──hash.changed / veto / producer squashed          │
      │                                                        │
      └── refork effect → speculating, generation+1, diagnosis │
                                                               │
   vetoed ◀── POST /veto on head only                          │
```

Key invariants:

- **Ready requires `commit == headCommit`.** A push to a `ready` / `checking`
  / `failed` / `squashed` entry returns it to `speculating` — "retry" is
  push + ready again.
- **Checks run only at the head.** A ready non-head entry waits; this is
  what makes retirement strictly in-order.
- **Squash sets `diagnosis`** (`reason` + per-symbol old/new hashes and
  signatures + producer commit) and bumps `generation`; the diagnosis is
  cleared when the agent pushes again.
- **Veto reparents dependents.** A veto squashes exactly the transitive
  dependents; each re-forks from the vetoed entry's *own base* and its
  `producerId` is repointed to the vetoed entry's producer, so dependents
  can still satisfy "producer retired" later.
- **`robSize` counts non-retired entries** — vetoed entries occupy a slot
  until `POST /api/reset`.

## Value prediction (declared stubs)

Forwarding lets a consumer start on the producer's *current* head. Value
prediction lets it start on the producer's *declared intent* — before the
producer has pushed anything.

- **Registration.** `POST /api/entries` accepts `stub: Record<path, string>` —
  TypeScript sources declaring the entry's intended exported signatures. The
  DO hashes them with the real `hashInterface` (stub hashing happens in
  `do.ts`, keeping `rob.ts` pure — same split as push hashing), so
  `entry.exports` starts as *predicted* hashes and `entry.predicted` lists
  the unconfirmed symbols (`app/CONTRACTS.md`).
- **Pinned consumes.** A consumer registering while `producer.predicted` is
  non-empty forwards against the declared hashes: its `consumes[sym]` records
  the predicted hash and is pinned in `_internal.predConsumed[consumerId]`.
  `fork.done` keeps the declared hashes/signatures for predicted symbols (the
  new fork carries pre-push base content) and keeps the pinned consumes values
  instead of overwriting them with the fork's exports.
- **Resolution.** The producer's first push that carries real exports clears
  `predicted` and resolves each pinned symbol per consumer: hash match →
  `prediction.hit` and `stats.predictionHits++`; divergence →
  `prediction.miss`, `stats.predictionMisses++`, and a squash with
  `reason: "prediction-miss"` (the diagnosis carries predicted vs actual
  signatures; non-pinned drift in the same push is merged into it).
  A declared symbol the push never delivers yields `actualHash: ""` — a miss
  for any consumer that pinned it. A *pure* hit (all pins match, nothing else
  changed) counts as neither squash nor early cutoff. Prediction squashes go
  through `squashTree` like any squash, so a missed consumer's dependents
  cascade.
- **Post-resolution.** Later pushes are ordinary interface changes, and a
  consumer registering after the producer's first push sees actual exports —
  no pin, no verdict (by design).
- **Dashboard.** `≈` dashed markers on predicted exports, `≈ stub` on
  forwarded consumes, `✓ hit` / `✗ miss` ticks once verdicts land, and a
  stats-bar `stub predictions: X hit / Y miss` counter
  (`app/control-plane/NOTES.md`).

## Events

`ArbEvent` (`app/CONTRACTS.md`) is the single stream consumed by the
dashboard over `GET /api/ws` (WebSocket, hibernation API) and recorded in
the DO's internal log — also readable at `GET /api/events` (debug endpoint;
all live timings below were measured from it). On connect the server first
sends `{type:"snapshot", data: BufferState}` — `snapshot` is intentionally
outside the contract's union (contract issue noted in
`app/control-plane/NOTES.md`).

| Event | Fires when | Carries |
|---|---|---|
| `entry.created` | `POST /api/entries` forks trunk or a producer fork | entry |
| `push` | `repo.pushed` (queue or alarm poll) deduped and hashed | repo, commit |
| `hash.unchanged` | push changed no exported-symbol hash | — (early cutoff) |
| `hash.changed` | ≥1 exported-symbol hash moved | symbol, oldHash, newHash |
| `squash` | a consumed symbol changed / producer vetoed / producer squashed / trunk overlap / prediction miss | entryId, diagnosis; `trunk-overlap` squashes also carry `overlap: string[]` (the intersecting paths); `prediction-miss` diagnoses carry predicted vs actual signatures |
| `prediction.hit` / `prediction.miss` | the producer's first push resolved a consumer's pinned symbol (hit: actual == declared; miss: diverged — the consumer is also squashed `prediction-miss`) | `entryId` = consumer, `data.producerId`, `symbol`, `hash` (hit) / `predictedHash`, `actualHash`, `predictedSignature`, `actualSignature`, `commit` (miss) |
| `refork` | new fork minted for a squashed entry | repo, generation |
| `ready` | agent POSTs ready | commit |
| `check.started` / `check.passed` / `check.failed` | head entry's `runChecks` | commit, durationMs, results; on a splice candidate they carry `splice: true` and the candidate commit on the trunk repo |
| `retired` | head entry landed on trunk | commit, `mode: "fast-forward" \| "splice"`, durationMs |
| `veto` | head-entry veto | entryId, squashed[] |
| `config` | `POST /api/config` | robSize |
| `reset` | `POST /api/reset` | — |

## Retirement modes

Retirement never produces a textual merge. Per the Decision in
`odd/tasks/agent-reorder-buffer.md` (which superseded the original
fast-forward-only plan after T4 found consumer forks can stop containing the
producer's final head after an early-cutoff push):

1. **Fast-forward** — trunk head is an ancestor of the entry head.
   The retirer fetches the fork branch into an in-memory object store,
   verifies descent with `git.isDescendent`, and pushes non-forced; the git
   server independently re-enforces fast-forward. Spike-measured ~0.9 s
   median, 17–45 ms CPU (`app/retirer-spike/NOTES.md`); live in the
   integrated DO: 507 ms (e1) and 518 ms (e2) (`app/control-plane/NOTES.md`).
2. **Path-disjoint splice** — trunk moved on disjoint paths. P = paths the
   entry changed vs its `baseCommit`; Q = paths trunk changed since that
   base. If P ∩ Q = ∅, a new commit overlays P onto the trunk tree with
   `parents = [trunk head]` and message `arb: splice <entry-head> onto
   <trunk-head>` (observed live: trunk head `a65620fe` =
   `arb: splice 7c42bc81 onto f4a406a3`). Disjoint changes commute (patch
   theory), so the splice is order-independent. The candidate is pushed to
   `refs/heads/arb-candidate` on the trunk repo, `runChecks` executes on
   that candidate (check events carry `splice: true`), and only on pass is
   `main` moved to it. Live: 1085 ms end-to-end for e3 (diff + overlay +
   candidate push + branch move), candidate check 90 ms
   (`app/control-plane/NOTES.md`).
3. **`trunk-overlap` squash** — P ∩ Q ≠ ∅. The entry is squashed so its
   agent re-applies on a fresh fork *from trunk* (the collision is with
   trunk; re-forking from the producer would livelock once the producer has
   retired). The `squash` event's `data.overlap` lists the intersecting
   paths. This extends the contract's `Diagnosis.reason` union.

## Failure modes and handling

| Failure | Detection | Handling |
|---|---|---|
| Interface mispredict | consumed symbol hash changed | squash dependents transitively; refork + diagnosis; `generation+1` |
| Body-only push | aggregate hash unchanged | early cutoff — no work, `hash.unchanged`, `stats.earlyCutoffs++` |
| Failed check at retirement | `check.failed` | entry → `failed`, blocks retirement; next push → `speculating`; ready retries |
| Trunk moved under an entry | FF ancestry check fails | path-disjoint splice, or `trunk-overlap` squash |
| Queue event lost/delayed | alarm poll every ~3 s over trunk + live repos | dedupe by `repo:commit` (`seenPushes`, cap 500) + `headCommit` equality; spike-measured poll detection median 0.70 s, live push→`push` event observed 1–3 s (queue lands inside the poll cadence; sources aren't tagged in the log) |
| Duplicate push (queue + alarm both fire) | same dedupe keys | second delivery is a no-op |
| Push during in-flight refork | pushes to the stale repo name are ignored | known gap: work on the stale fork must be redone |
| Effect failure (fork throws) | 500 / queue retry | entry's pending-refork flag persists until a later push reuses it; no automatic unjam |
| Transient platform error (1042/1104) | spike-observed flakiness | retry once (`spikes/SPIKES.md`) |
| DO version pinning after deploy | an alarmed DO (~3 s cadence) stayed on the previous deployment *indefinitely* (observed live) | worked around by bumping `DO_NAME` in `src/index.ts` so a fresh object spawns on the new deployment; old objects become harmless zombie pollers. Pending fix: `/api/reset` should clear `trunk.repo` so the alarm chain dies (`app/control-plane/NOTES.md` known gaps) |
| Repo name collision after reset | `ALREADY_EXISTS` on fork create | retry as `arb-e<seq>-<lane>-<n>-x<k>`, `repoAlias` resolves dependents' sources |
| LOADER cache cold machine | slow check | retry; worst observed ~7.7 s end-to-end |
| Squash storms on long chains | — | bounded by `robSize` (speculation depth), same as hardware |
| Human veto of wrong entry | veto restricted to head; dependents previewed in UI | transitive dependents squash and reparent (recoverable) |
| Persisted-state shape change on redeploy | constructor forward-fills `_internal` | `{...initialState()._internal, ...stored}` |

## Scale

### The design argument

- **Cost ∝ DAG edges, not agents.** All coordination work — hash compare,
  squash fan-out, retirement order — touches only `consumes`/`exports`
  records of in-flight entries. Agents with no dependency edges between them
  never interact.
- **Early cutoff is the common case.** Most pushes are body edits; an
  unchanged interface hash costs one tree read + ~30 ms of hash CPU and
  wakes nobody.
- **One DO per connected component.** A single-threaded DO is the correct
  serialization point *per dependency component*: retirement order only
  needs to be total within a component. The current build runs one
  `default-t11` DO; the BufferState carries no cross-component data, so
  routing `idFromName(componentId)` is the horizontal path. (Cloudflare's own
  experience with single-coordinator DOs motivated this design —
  `research/top10.md` Idea 2 cites the Workflows V1→V2 migration.)
- **Forks are near-free.** Spike 3 measured 10 parallel forks in 1.9 s wall;
  a squash costs the fan-out of one changed interface, paid only on
  mispredict.
- **The expensive parts are constant-size.** Check = one Dynamic Worker per
  head entry (~261 ms warm). Retirement = one git ff (~0.9 s). Neither grows
  with fleet size.
- **`robSize` bounds mispredict amplification** on long chains — the same
  reason hardware reorder buffers are finite.

### The T12 benchmark — method

`app/control-plane/bench/RESULTS.md`; reproduce in ~2 min:
`cd app/control-plane && node --experimental-strip-types bench/run.ts`
(`BENCH_N`, `BENCH_MODE=single|sharded`, `BENCH_HOT=k`).

- **Subject:** the pure `apply()` in `src/rob.ts` — no network, no Durable
  Object I/O. State is built directly (`entry.create` is itself O(N) and was
  not timed); `robSize` set above N.
- **Topology:** complete ternary trees — fan-out 3, depth 3, 40 entries per
  component, C = N/40 components at N = 1,000 / 10,000 / 100,000.
- **Load:** a seeded, deterministic event stream — interface-changing pushes,
  body-only pushes, `entry.ready`, and interpreter-style `fork.done` /
  `check.done` / `retire.done` fed back from emitted effects. 4,000 / 2,500 /
  1,200 timed events per mode (+150 warmup). Not exercised: `entry.create`,
  veto, `retire.planned`, `retire.overlap`.
- **Modes:** (a) `single` — one state with all N entries; (b) `sharded` —
  C states of 40 entries, each event routed to its component.
- **"scan":** callback evaluations in `entries.find/filter/map/sort/reduce`
  per `apply()`, counted on a deterministic replay through a Proxy — not in
  the timed run.
- **Hardware:** Ryzen 5 7530U, Windows 11, Node v22.15.1.

### Results

Median / p95 µs per event, all kinds mixed:

| N | single med | single p95 | single scan (mean) | sharded med | sharded p95 | sharded scan (mean) |
|---|---|---|---|---|---|---|
| 1,000 | 29.6 | 92.3 | 3,085 | 2.9 | 11.9 | 116 |
| 10,000 | 393.6 | 1,462.6 | 31,290 | 6.2 | 21.0 | 134 |
| 100,000 | 16,208 | 55,220 | 304,219 | 17.2 | 48.3 | 187 |

- **Single buffer grows ~linearly or worse.** Median rose 13× for 10×
  entries, then 41× for the next 10× (not isolated — likely allocation/GC of
  large temporaries plus cache misses). Every event pays it, including ones
  touching two entries. Line-level causes (for that revision): `head()` — a
  filter+sort over all entries — runs at the end of *every* `apply()` via
  `cascade()` (the exact-2N scan on `check.done`: 1,999 / 19,999 / 199,999+
  evaluations); `squashTree` and the push loop scan all entries per squashed
  node ((k+1)·N for a push squashing k; max 4.28M scans observed on one push);
  `find()` lookups and the pending reverse lookup. Whole-state `v8.serialize`
  per `persist()`: 3.2 / 45 / 634 ms.
- **Sharded work is flat in N.** Scans 116 / 134 / 187 mean — 80 for
  `check.done` at every N, i.e. exactly 2 × 40. Wall medians still rose 2.9 /
  6.2 / 17.2 µs, but a hot-shard control (`BENCH_HOT=25` — events confined to
  25 shards inside the same 2,500-state heap) gave median 3.8 µs / p95 16.3:
  the rise is memory locality of the one-process simulation, not algorithmic
  growth (single control run).
- **Containment verified, not assumed.** Every push (3,803 across both modes)
  was checked against an independent oracle built from the DAG and pre-push
  `consumes`: 0 mismatches, 0 squashes outside the pushed entry's transitive
  dependents. Interface-push squash counts were subtree sizes — 3 / 12 / 39
  (depth-2 / depth-1 / root), mean 7.5, p95 39 at N=100k — bounded by fan-out,
  independent of N.
- **State size:** ≈740 bytes/entry as JSON — 0.65 MB / 6.9 MB / 74 MB single,
  similar sharded-total; the 200-event `eventLog` adds ~30 KB per shard.
  Durable Object storage value limits were *not* verified in this run — the
  single-DO state is already written as one value.

### The fix, and what is still unmeasured

Recommended in `RESULTS.md` (not applied, not measured as a patch): a
monotone cursor to the first live entry (O(1) amortized `head()`);
`Map<id,Entry>`, `Map<repo,Entry>`, `Map<producerId,Entry[]>` and a pending
repo→id map; per-entry-key or delta persistence instead of whole-state
writes. Acting on it — index maps plus one `ReorderBuffer` DO per connected
component (routing by root producer) — is dispatched as T14; as of this
writing `src/index.ts` still resolves a single `idFromName("default-t11")`
object and `rob.ts` has no index maps.

Caveats (from `RESULTS.md`): synthetic uniform workload with uniform routing;
complete ternary trees only — no cross-component edges, no shared producers;
single-process wall clock on a laptop with GC noise (10k/100k single-mode
figures from 2,500 / 1,200 events; the 100k p95 comes from dozens of events
per kind); event-kind proportions differ per mode and size — compare the
all-kinds rows loosely, the per-kind rows precisely; sharded runs retire
fewer entries at large N because each shard has its own head and receives few
events. Cross-component dependencies, routing, real DO latency, and DO
storage limits remain unmeasured.

## Known seams

Tracked per package in each `app/*/NOTES.md` under "Contract issues" and
"Known gaps": `snapshot` event outside the `ArbEvent` union, reset-time repo
naming (`arb-e<seq>-<lane>-<n>-x<k>` suffix retry + `repoAlias`), DO version
pinning on alarmed objects, `ArbEvent.data` loosely typed (dashboard folds
the deployed flat payload shapes defensively), hasher inference limits
without a type checker, and the stale-fork push window.
