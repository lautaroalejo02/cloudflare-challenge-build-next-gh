# arb-control-plane — NOTES

Worker + Durable Objects (`ArbRouter` + `ArbTrunk` + one `ReorderBuffer` per
connected component — T14 sharding) + queue consumer + HTTP/WS API.
Deployed: `https://arb-control-plane.lautitomasalejo.workers.dev`

## What was built

- `src/rob.ts` — pure reorder-buffer state machine (no Cloudflare imports).
  `apply(state, cmd, now)` mutates and returns `{ state, effects }` where
  effects are fork / token / check / retire / broadcast requests executed by
  the DO. Internal bookkeeping (`_internal`: signature texts, in-flight
  forks, check/retire dedupe, push dedupe, event log) is persisted but
  stripped from `GET /api/state` via `publicState()`.
- `test/` — 54 node:test cases (run with `node --experimental-strip-types`,
  Node 22.15): `rob.test.ts` state machine (forwarding, early cutoff, squash
  + diagnosis, transitive squash, in-order retirement, failing check +
  retry, robSize 409, veto + transitive dependents, veto non-head 409,
  reset, push dedupe/unknown-repo, pending-refork dedupe, atomic retire
  checked/retry/failed/overlap paths + strike bound + stale-drop, no-op
  ready on squashed refork, declared-stub value prediction),
  `splice.test.ts` pure path-disjoint decision, `retire.test.ts` git-level
  fast-forward/splice/already-on-trunk on `MemFs` + isomorphic-git,
  `atomic.test.ts` pure retry-loop races/rebuilds/exhaustion.
- `src/ports.ts` — port interfaces + real implementations:
  - `ArtifactsPort` — wraps the `ARTIFACTS` binding (create / fork /
    token / log / readTree). `readTree` walks the commit's root tree
    recursively via `readCommit` -> `treeHash` -> `readTree` and returns every
    `.ts` file as `path -> source` (spike 1/3 code shape, disposable handles).
  - `HasherPort` — real `app/hasher` tree-sitter hashing; keeps the full
    export signature text for squash diagnoses.
  - `CheckerPort` — real `app/checker` `runChecks` in a Dynamic Worker via
    the `LOADER` binding (`worker_loaders`): checks out the candidate
    commit's tree and runs `run()` from `tests/**/*.test.{ts,js,mjs}`.
  - `RetirerPort` — `src/retire.ts`: isomorphic-git on `MemFs`. Fast-forward
    when trunk head is an ancestor; otherwise the path-disjoint splice
    (P∩Q=∅: trunk tree + entry's changed paths overlaid, pushed to
    `refs/heads/arb-candidate`, checked, then `main` moved) — overlap →
    `retire.overlap` → squash `trunk-overlap`. `src/splice.ts` is the pure
    decision fn.
- `src/do.ts` — `ReorderBuffer` DO, one instance per connected component
  (`comp-<rootEntryId>`; T14 — see "Sharding"). State persisted in DO
  storage. Executes effects through ports; retire effects go to `ArbTrunk`;
  ArbEvents relay to `ArbRouter` for `/api/ws` fan-in. DO alarm polls every
  ~3s (spike 2b) over the component's live entry repos only (the trunk repo
  belongs to `ArbTrunk`) when `POLL_FALLBACK != "off"`; dedupes against
  queue events by `repo:commit` and `headCommit`. `GET /internal/events`
  exposes the ring-buffer event log to the router.
- `src/router.ts` — `ArbRouter` DO (`router-t14`): global seq allocation,
  entry/repo → component routing table, `POST /api/entries` orchestration
  with global `robSize`, `/api/state` + `/api/events` aggregation across
  components, `/api/ws` hub, config/reset fan-out.
- `src/trunk.ts` — `ArbTrunk` DO (`trunk-t17`): serialized `retireAtomic`
  on `arb-trunk` (one promise-queue slot spans head-read → candidate →
  check → move, with bounded in-slot rebuilds; the legacy `retire` /
  `moveBranch` RPCs remain but are unused), trunk-init, sole trunk alarm
  poller, authoritative trunk head.
- `src/atomic.ts` — pure `retireAtomic` retry loop over `RetirerPort` +
  `CheckerPort` (no Cloudflare/git imports, unit-testable).
- `src/shard.ts` — pure helpers: `componentName`, `repoToEntryId`,
  `mergeStates`, `mergeEvents`.
- `src/index.ts` — Worker: `POST /api/trunk/init` -> `ArbTrunk` (+ router
  inform), other `/api/*` -> `ArbRouter`, queue consumer -> repo-routed
  `onPush(repo, after)` filtered to `cf.artifacts.repo.pushed` on
  `refs/heads/main` in namespace `arb`, everything else -> `env.ASSETS`.
- `wrangler.toml` — name `arb-control-plane`, artifacts `arb`, DO bindings
  `ROB`/`ROUTER`/`TRUNK`, migrations v1 `[ReorderBuffer]` + v2
  `[ArbRouter, ArbTrunk]`, queue consumer `arb-push-events`
  (`max_batch_timeout=1`), assets `../dashboard` with `run_worker_first` +
  `ASSETS` binding, `nodejs_compat`, `worker_loaders` `LOADER`, rules
  `CompiledWasm` for `tree-sitter.wasm`, vars `POLL_FALLBACK=on`,
  `POLL_INTERVAL_MS=3000`.
- `scripts/setup.sh` — creates queue + namespace-wide event subscription.

## Run / test / deploy

```sh
npm install
npm test                 # 54 unit tests (state machine + splice + git + atomic), no CF needed
npx tsc --noEmit         # typecheck (also compiles app/hasher + app/checker sources)
npx wrangler types       # regenerate worker-configuration.d.ts
scripts/setup.sh         # queue + subscription + deploy (Wrangler >= 4.149)
```

Git auth for pushes: `https://x:<token>@<remote-host>/<path>` with the
`?expires=` suffix stripped from the token, `GIT_TERMINAL_PROMPT=0`.

## Smoke test results (curl + git, 2026-10-13)

1. `POST /api/trunk/init` -> `{repo:"arb-trunk", remote, token}`; pushed
   `src/api/order.ts` fixture via git.
2. `POST /api/entries {agent,lane:"api"}` -> `e1`, `arb-e1-api-0`, exports
   `{createOrder:21ecd7d9917e, Order:b8feb780d58d}`.
3. `POST /api/entries {lane:"ui",producerId:"e1",consumes:["createOrder"]}` ->
   `e2`, `arb-e2-ui-0`, `consumes.createOrder=21ecd7d9917e` (forwarded hash).
4. `git push` signature change to `arb-e1-api-0` -> within ~8s:
   `pushesSeen:1`, `e2` squashed, diagnosis `interface-changed` with
   old/new signatures, reforked to `arb-e2-ui-1` (gen 1), consumes updated to
   `2176e3a5e331`.
5. `git push` body-only change -> `earlyCutoffs:1`, no new squash.
6. `POST /api/entries/e1/ready` -> sync check (stub) + retire; e1 `retired`,
   `trunk.commit` = e1 head, `stats.retired:1`, `checksRun:1`.
7. `GET /api/entries/e2` after refork -> response included fresh `token`.
8. `POST /api/entries/e2/veto` -> 200, e2 `vetoed`, `squashed:[]` (no deps).
9. `GET /api/ws` -> HTTP 101; `GET /` -> 200 text/html (dashboard).
10. `POST /api/reset` -> `{ok:true}`; state cleared, trunk kept.

## Live E2E results (T8, deployed `arb-control-plane`)

`npm run demo -- --base https://arb-control-plane.lautitomasalejo.workers.dev`
— both scenarios exit 0 against the real plane (real hasher / Dynamic-Worker
checker / isomorphic-git retirer on `arb-trunk`).

**Main scenario** — ~38 s wall. `earlyCutoffs=2` (body-only refactor),
`squashes=2` (breaking `createOrder` signature change re-forked both
consumers), `retired=3`, `checksRun=3`, `pushesSeen=5`. e3's re-apply was a
no-op (intent already on reforked base) and retired via the
ready-while-squashed path. Trunk verified by clone: `order.ts` v2
`{region,currency}` signature + `sumCart`, `checkout.ts` v2
`renderExpressCheckout`, both test files present.

**Failing-check scenario** — 43.8 s wall (46.4 s incl. agent startup).
`stats={"squashes":2,"earlyCutoffs":2,"retired":3,"checksRun":5,"pushesSeen":7}`.
e3's gen-1 push carried a deliberately failing feature test: the real
check ran on its head commit, failed, and blocked retirement until the
scripted fix landed — e3 then retired via **splice** (trunk head
`a65620fe` = `arb: splice 7c42bc81 onto f4a406a3`, ≠ entry head).

Measured timings (DO event log, `/api/events`):

| metric | value |
|---|---|
| push → squash | ~1.7 s end-to-end (push detected + hash + squash in one poll tick; `squash` emitted same instant as `hash.changed`) |
| push → early cutoff | same tick (`hash.unchanged` for both consumers at detection) |
| squash → refork done | e2 ~2.3 s, e3 ~4.5 s (parallel forks) |
| check duration (Dynamic Worker) | 90–187 ms (e1 173, e2 94, e3-fail 187, e3-fix 179, e3-candidate 90) |
| failed check → fix detected | ~2.8 s (agent poll + push + poll) |
| retire fast-forward | e1 507 ms, e2 518 ms |
| retire splice | e3 1085 ms (diff + overlay + candidate push + move) |

Push detection path: queue subscription `arb-push-events` and the ~3 s
alarm-poll fallback both feed the same deduped `push` cmd; the event log
does not tag the source. Observed detection latency (agent push →
`push` event) was 1–3 s, consistent with queue delivery inside the poll
cadence. `pushesSeen` counts unique `repo:commit` pairs, so both paths
firing costs nothing.

Scenario timeline (trimmed, `--scenario failing-check`):

```
[+   4.1s] fixture pushed to trunk at 45932c42
[+   6.5s] [api   ] registered e1 repo=arb-e1-api-0-x12
[+  11.0s] [ui    ] registered e2 repo=arb-e2-ui-0-x9
[+  12.9s] [tests ] registered e3 repo=arb-e3-tests-0-x8
[+  13.8s] [ui    ] pushed 7506625a "feat(ui): express checkout line"
[+  14.9s] [api   ] pushed 70279cd8 "refactor(api): extract sumCart helper"
[+  16.2s] [tests ] pushed 4d21547d "test: add createOrder feature coverage"
[+  17.1s] [buffer] stats.earlyCutoffs 0 -> 2          (body-only producer push)
[+  26.1s] [api   ] pushed 4b1a3c85 "feat(api)!: createOrder now takes { region, currency } options"
[+  29.1s] [buffer] e2/e3 ready -> squashed            (interface-changed diagnosis)
[+  30.0s] [buffer] e1 ready -> check.started
[+  30.8s] [buffer] e1 -> retired  mode=fast-forward (507ms)
[+  31.8s] [ui    ] cloning arb-e2-ui-1-x9 -> e2-g1 (generation 1)
[+  33.3s] [ui    ] detected v2 - applying v2 checkout variant
[+  34.4s] [ui    ] pushed f4a406a3 "feat(ui): reapply express checkout"
[+  35.7s] [tests ] detected v2 - writing v2 FAILING feature test
[+  37.1s] [tests ] pushed 3e114e2c (gen 1)
[+  38.8s] [buffer] e2 -> retired  mode=fast-forward (518ms)
[+  40.5s] [buffer] e3 squashed -> checking
[+  41.3s] [buffer] e3 checking -> failed  (1 failing, 187ms — retirement blocked)
[+  41.6s] [tests ] checks failed - applying scripted fix
[+  43.7s] [buffer] e3 failed -> speculating (fix push detected)
[+  44.6s] [buffer] e3 -> ready (re-check on head: pass, 179ms)
[DO +43.4s] e3 splice candidate a65620fe checked (90ms, splice:true)
[+  45.3s] [buffer] e3 -> retired  mode=splice (1085ms); trunk=a65620fe
[+  46.4s] [final ] all three retired in order
```

## Value prediction (T11)

**What:** `POST /api/entries` accepts `stub: Record<path,string>` —
TypeScript sources declaring the entry's intended exported signatures. The
DO hashes them with the real hasher (`do.ts`), so `entry.exports` starts as
*predicted* hashes and `entry.predicted` lists the unconfirmed symbols.
Consumers registering while `producer.predicted` is non-empty forward
against the declared hashes (`consumes[sym]` = predicted; pinned in
`_internal.predConsumed[consumerId]`). The producer's first push carrying
real exports resolves each pinned symbol per consumer: match →
`prediction.hit` + `predictionHits++`; diverge → `prediction.miss` +
`predictionMisses++` and a squash with `reason: "prediction-miss"`
(diagnosis carries predicted vs actual signatures; non-pinned drift in the
same push is merged into the diagnosis). Later pushes are ordinary
interface changes.

**Mechanics (rob.ts):** `fork.done` keeps declared hashes/sigs for predicted
symbols (the new fork carries pre-push base content) and keeps pinned
consumes values instead of overwriting them with the fork's exports. On
`push`, `predictedSyms`/`predSigs` are snapshotted before real exports
overwrite `target.exports`/`predicted`; verdicts run per live consumer
before the ordinary `consumedDiff` handling. A pure hit (all pins match,
nothing else changed) counts as neither squash nor early cutoff. Prediction
squashes go through `squashTree` like any squash, so dependents of a missed
consumer cascade.

**Demo:** the API agent registers `stub: {"src/api/order.ts": ORDER_STUB}`
(v1 signatures with a throwing body). UI + Tests register ~1.5 s apart while
`predicted` is still set, forwarding `createOrder`/`Order` (ui) and
`createOrder` (tests) against the declared hashes. The first real push lands
`createOrder` exactly as declared but adds `currency` to `Order` → e2 hits
createOrder + misses Order (squashed `prediction-miss`, gen 1), e3 hits
createOrder (keeps running). The scripted v2 breaking change then squashes
both as `interface-changed`, as before. `--scenario failing-check` takes the
same path.

**Dashboard:** stats bar "stub predictions: X hit / Y miss"; producer export
tags carry a dashed `≈` marker while `predicted` is non-empty; consumer
forwarded tags show `≈ stub` while the producer's prediction is unconfirmed
and `✓ hit`/`✗ miss` ticks once the verdict lands (ticks reset on refork);
`PREDICTION HIT/MISS` lines in the event log; `mock.js` replays the full
predicted → hit/miss → squash → cutoff → retire flow.

**Tests:** `rob.test.ts` +7 cases (stub registration marks exports
predicted, pinned consumes survive fork.done, hit/miss verdicts on the first
push, miss → refork, a later push is an ordinary squash, post-resolution
consumers see actuals, non-predicted changes unaffected). `agent.test.ts`
+1 full-run case asserting 2 hits / 1 miss and a `prediction-miss` squash
against the mock control plane. `state.test.js` +3 cases (predicted field
folding, push clears the marker, verdict ticks + stats) and mock-replay
expectations updated (squashes 4, pushesSeen 8, hits 2 / miss 1).

**Decisions:**
- Stub hashing happens in `do.ts` (`hashInterface` over `body.stub`), keeping
  `rob.ts` pure — same split as push hashing.
- The demo stub declares the current v1 interface (the task's example), so
  pinned hashes equal the fork base — the showcase is the declared-intent
  bookkeeping: hits mean "delivered as promised", misses mean "reality
  differed". A stub that declares a not-yet-existing interface works
  identically (its predicted hash differs from base and still resolves on
  the first push).
- `entry.predicted` clears on the first push that carries `cmd.exports`; the
  real plane hashes every entry push, so resolution is total. A declared
  symbol the push never delivers yields `actualHash: ""` → a miss for any
  consumer that pinned it.
- `DO_NAME` bumped to `"default-t11"` for a fresh DO on deploy (warm-alarm
  version pin — see Known gaps).

**Contract issues:**
- `POST /api/entries` gained `stub`; `Entry.predicted`,
  `Diagnosis.reason = "prediction-miss"`, `stats.predictionHits/Misses`, and
  `prediction.hit`/`prediction.miss` events were added to `app/CONTRACTS.md`
  with changelog lines. Verdict events carry `entryId` = consumer +
  `data.producerId` — same convention as `hash.changed`.
- `entry.created` now emits `exports`, `consumes`, `predicted` in `data`
  (previously `{agent, lane, seq, producerId, repo}` only) so the dashboard
  can mark predicted exports before the first snapshot refresh.

**Resources:** none new — same Worker / DO / queue / namespace. Deployed
version `a1c784f2-456f-4920-a790-2de3277d7e3b`.

**Known gaps:**
- A consumer registering after the producer's first push sees actual exports
  (no pin, no verdict) — by design.
- Predictions resolve only on pushes that carry hashed exports; the real
  plane always hashes entry pushes, so no unhashed-push path exists today.

**Live (2026-10-13, deployed `arb-control-plane` @ a1c784f2):**
- Main scenario: exit 0 in ~52 s. `predictionHits=2`,
  `predictionMisses=1`, `squashes=3` (e2 prediction-miss + e2/e3
  interface-changed), `earlyCutoffs=0`, `retired=3`, `checksRun=4`,
  `pushesSeen=7`.
- `--scenario failing-check`: exit 0 in ~50 s. Same verdicts; e3's scripted
  failing check still blocked retirement until the fix (`checksRun=5`).
- Re-run for screenshots: exit 0 in ~47 s, same stats.
- Timeline (main run): api registers with stub +10.5 s → consumers +14.5 /
  +15.7 s → first api push +21.8 s → verdicts + squash detected +24.3 s
  (one poll tick) → e2 refork +26.1 s → breaking push +35.0 s → ordinary
  squashes +36.9 s → all retired +51.6 s.
- Screenshots: `app/dashboard/screenshots/live-predicted.png` (`≈` markers
  on e1's predicted exports + `≈ stub` on e2's forwarded tags — consumers
  running against the declared stub pre-push), `live-prediction.png`
  (verdict moment: "1 hit / 1 miss" counter, e2 `✓ hit` / `✗ miss` ticks,
  PREDICTION HIT/MISS log lines), `live-squash.png`, `live-final.png`.

## Sharding (T14)

**What changed.** The single `default-t11` DO became three roles:

- `ArbRouter` (`router-t14`, `src/router.ts`) — routing table
  (`entryId→comp`, `repo→comp`, global `nextSeq`), `POST /api/entries`
  orchestration (producer's component, else `comp-<rootId>`), GLOBAL
  `robSize` via per-component `/internal/active` fan-out, `/api/state` +
  `/api/events` aggregation, `/api/ws` hub (component DOs push events to
  `/internal/emit`), config/reset fan-out.
- `ArbTrunk` (`trunk-t14`, `src/trunk.ts`) — the ONE shared resource. All
  `retire`/`moveBranch` calls from every component are serialized through
  an in-memory promise queue (DO handlers interleave on `await`, so
  single-threaded alone is not enough). Sole poller of `arb-trunk`; owns
  the authoritative `trunk.commit` for aggregation.
- `ReorderBuffer` (`comp-<rootId>`, `src/do.ts`) — one DO per connected
  producer/consumer component. Retire effects call the `ArbTrunk` stub via
  the `RetirerPort` interface; alarms poll only the component's own live
  entry repos.

`src/index.ts` routes `POST /api/trunk/init` to `ArbTrunk` (then informs the
router), all other `/api/*` to `ArbRouter`, and queue push events by repo
name: `arb-trunk` → `ArbTrunk.onPush`, `arb-e<seq>-*` → the owning
component (`repoComp` table, `repoToEntryId` fallback). Unknown/stale repos
(leftover after reset) are dropped.

**`rob.ts` index maps** (`_internal.idx`, JSON-persisted, healed lazily):
`byId`, `byRepo`, `childrenOf`, `pendingRepo`, monotone `headCursor`,
`active` counter. `entries` stays sorted by seq (out-of-order global seqs
splice in). `entry.create` accepts router-injected `id`/`seq`. Benchmark
rerun — median per-event time went **flat** (was O(N) scans):

| entries | before, median / p95 | after, median / p95 | scans/event |
|---|---|---|---|
| 1,000 | 29.6 µs / 92.3 µs | 2.1 µs / 19.3 µs | ~0 |
| 10,000 | 393.6 µs / 1,462.6 µs | 2.4 µs / 18.8 µs | ~0 |
| 100,000 | 16,208 µs / 55,220 µs | 2.7 µs / 23.3 µs | ~0 |

Residual single-DO cost is now state serialization: 80 MB / ~732 ms
`v8.serialize` at N=100k vs ~0.08 ms per 40-entry component state —
the concrete argument for the DO split. Details in `bench/RESULTS.md`.

**Live verification** (deployed version `8bfc389a-…`, all exit 0):

- **main** — 59 s wall. `squashes=3 earlyCutoffs=2 retired=3 checksRun=4
  pushesSeen=8 predictionHits=2 predictionMisses=1`, trunk retired=3.
- **failing-check** — 62 s wall. Same shape, `checksRun=5` (failed run →
  scripted fix → retired), trunk retired=3.
- **multi** (new: orders `api→ui+tests` vs payments `api→ui`) — 80 s wall.
  `squashes=3 earlyCutoffs=3 retired=5 checksRun=9 pushesSeen=11
  predictionHits=2 predictionMisses=1`, trunk retired=5. Components
  verified in `/api/state`: `e1,e3,e4 → comp-e1`, `e2,e5 → comp-e2`. e5
  squashed exactly once by its own producer's breaking `charge` change;
  payments retired `e2` BEFORE orders' `e1` — no cross-component
  head-of-line blocking — while trunk mutations stayed serialized through
  `ArbTrunk`. Squash-isolation checked from `/api/events`: every interface
  squash pairs with a producer push in the same transitive root.

**DO name/version notes.** `default-t11` is gone; fresh objects
`router-t14` / `trunk-t14` / `comp-e*` mean no alarmed-object pinning on
this deploy (the old zombie `default-t11` object may still poll — it is
inert). `wrangler.toml` keeps migration v1 (`ReorderBuffer`) and adds v2
(`ArbRouter`, `ArbTrunk`).

## Trunk race fix (T17)

**Defect.** The T14 two-phase path — `retire()` builds a splice candidate on
the head it read, the component DO checks it, `moveBranch()` moves `main` —
left a window where another component could land first. `moveBranch` then
rejected non-fast-forward, the async retire effect threw, and
`_internal.retiring` stayed set: the component wedged at `ready` forever
(reproduced in `--scenario multi`, worked around in T16 with
`--delay-ready e5:30000`).

**Fix.** Retirement is now one atomic cycle inside `ArbTrunk`
(`src/atomic.ts` + `ArbTrunk.retireAtomic` RPC): the single queue slot spans
head-read → ff/splice/overlap decision → candidate build → candidate check →
`main` move, so no component can land mid-cycle. A rejected move records a
sanitized `reason` and rebuilds from the new head inside the same slot,
bounded at `MAX_ATOMIC_ATTEMPTS=3`; `overlap` and `check-failed` return
immediately (rebuilding the same paths can't change the verdict). The
component DO replays `attempts[]` into visible events — `retire.retry`
`{attempt, reason}`, candidate `check.*` (with `splice:true`), `retire.done`,
`retire.failed` `{reason, strike, exhausted}` — so every failure clears
`retiring` and the next cascade can retry, bounded by `MAX_RETIRE_CYCLES`.
The two-phase `retire.planned`/`retire.commit`/`retireCandidate` protocol is
gone; the plain `check` effect also converts a thrown `runChecks` into a
failed verdict instead of wedging `checking`.

**Ordering preserved.** In-order per component (one retire effect at a
time), no cross-component head-of-line blocking (each component's cycle is
one queue slot, others queue behind, not inside), checks always run on the
exact candidate commit that becomes trunk — observed in `/api/events` as
`check.*` `{splice:true}` on the landed commit hash.

**Deploy note.** First T17 deploy (`a3a08161`) surfaced the DO version-pin
gap again: component DOs restarted on the new code but alarmed `trunk-t14`
kept serving the old class — `retire.failed` `"RPC receiver does not
implement the method \"retireAtomic\""` strikes 1→3 → `exhausted` → entry
`failed` (the no-wedge path proving itself on its own defect class).
`TRUNK_NAME` bumped to `trunk-t17`; state re-derives via `trunkInit`.

**Live verification** (production `arb-control-plane`, deployed
`4e0fdc50-cd9f-4cbd-9adc-95a11cedf52d`, 2026-10-13 — all exit 0, no delay
flags):

| run | wall | squashes | earlyCutoffs | retired | checksRun | pushesSeen | hits/miss | retire.retry | retire.failed |
|---|---|---|---|---|---|---|---|---|---|
| multi #1 | 67 s | 4 | 3 | 5 | 8 | 12 | 2/1 | 0 | 0 |
| multi #2 | 77 s | 4 | 2 | 5 | 8 | 12 | 2/1 | — | — |
| multi #3 | 63 s | 4 | 3 | 5 | 8 | 12 | 2/1 | — | — |
| multi #4 | 66 s | 4 | 3 | 5 | 9 | 12 | 2/1 | — | — |
| multi #5 | 63 s | 4 | 3 | 5 | 8 | 12 | 2/1 | 0 | 0 |
| main | 56 s | 3 | 2 | 3 | 4 | 8 | 2/1 | 0 | 0 |
| failing-check | 58 s | 2 | 1 | 3 | 5 | 8 | 2/1 | — | — |

`retire.retry` is expected to be ~never now: the race it exists for is
closed by serialization (a rejection can only come from out-of-band trunk
writers). Runs #1 and #5's event feeds confirm 3 splice candidate checks
each, all on commits that became trunk head, and zero `retire.failed`.
`--delay-ready` is retired (see `app/dashboard/NOTES.md`).

## Cloudflare resources created

- Worker `arb-control-plane` (DOs `ReorderBuffer` + `ArbRouter` + `ArbTrunk`,
  migrations v1/v2 sqlite).
- Queue `arb-push-events`; subscription `arb-ns-push-sub` (id
  `cd1aea7b12074b56921e44accc165019`, `--source artifacts --events repo.pushed
  --source-namespace arb`).
- Artifacts namespace `arb`; repos `arb-trunk`, `arb-e1-api-0`, `arb-e2-ui-0`,
  `arb-e2-ui-1` (+ any created by later runs).

## Decisions

- **Namespace-wide subscription** (not per-fork): `wrangler queues
  subscription create --source artifacts.repo` *requires*
  `--source-repo-name` (verified on 4.149.0), so per-fork subscriptions would
  need runtime REST calls + an API token inside the Worker — not provisioned.
  `--source artifacts --events repo.pushed --source-namespace arb` works and
  delivers the same `cf.artifacts.repo.pushed` payload; the consumer maps
  `source.repoName` to entries. Both queue and alarm can fire; dedupe by
  `repo:commit` (`_internal.seenPushes`, cap 500) plus `headCommit` equality.
- **Veto reparents dependents**: a veto squashes exactly the transitive
  dependents; each re-forks from the *vetoed entry's own base* and its
  `producerId` is repointed to the vetoed entry's producer, so it can retire
  later (contract leaves this unspecified; otherwise dependents could never
  satisfy "producer retired").
- **Hashing happens in the DO between `apply` calls** (queue/alarm ->
  readTree -> hashInterface -> `push` cmd), keeping `rob.ts` pure and the
  hasher swap interface-only for T8.
- **Ready requires `commit == headCommit`**; a push to a `ready`/`checking`/
  `failed`/`squashed` entry returns it to `speculating`, so "next push
  retries" = push + ready again.
- **robSize counts non-retired entries** (contract literal): vetoed entries
  keep occupying a slot until `reset`.
- **Token on `GET /api/entries/:id`**: DO keeps `seenRepo[id]`; a fresh 1h
  token is returned iff `entry.repo !== seenRepo[id]`. Repo-keyed, not
  generation-keyed: Artifacts tokens are scoped to the *repo*, and the
  generation bumps before the async refork lands — minting on the gen
  bump produced old-repo tokens that 403'd the new-repo clone (observed
  live).
- **`entry.ready` on a squashed entry** is accepted when the refork has
  landed and `headCommit === baseCommit`: the no-op case where the new
  base already contains the intent — allows a no-op retire instead of
  leaving the entry stuck (observed live: tests agent's v2 intent was
  already on its reforked base).
- **Alarm polls trunk too** (detects out-of-band trunk pushes / stub-retirer
  drift — after reset it corrected `trunk.commit` back to the real head).
  ~1.8k `repo.log` calls/hr/repo idle; disable with `POLL_FALLBACK=off`.
- **Check runs only at head**, preserving in-order retirement; a ready
  non-head entry waits.

## Contract issues

- **Repo naming collides across resets.** `POST /api/reset` "does not delete
  repos" but entry names are `arb-e<seq>-<lane>-<n>` with seq restarting at 1,
  so the first `POST /api/entries` after a reset hit `ALREADY_EXISTS` (observed
  live). Workaround implemented in the DO: on `ALREADY_EXISTS` the fork is
  retried as `arb-e<seq>-<lane>-<n>-x<k>` (deterministic k=1..10, then random
  suffixes, up to 30 attempts — accumulated repos from many demo runs
  exhausted the small `-xN` space) and `_internal.repoAlias[planned] = actual`
  lets already-emitted dependent refork effects resolve the real source name.
  A run-epoch component in the contract naming scheme would remove the need
  for this.
- **Stale repos can share the pending fork name (fixed, T9c).** While a
  (re)fork is in flight, `_internal.pending[id]` holds the PLANNED name —
  which may collide with a repo left over from before a reset. A late `pushed`
  event for that stale repo was matched via `pending` and adopted as the
  entry's head/exports mid-flight (the entry even flipped back to
  `speculating`). `apply` now ignores ALL pushes for an entry while
  `pending[id]` is set — the agent has no token yet, so nothing legitimate
  can arrive; the fork's own head lands via `fork.done`. Covered by the
  "stale-repo push to the pending refork name is ignored" test.
- `Entry.status` has no `retiring` state and `Entry` has no field for
  in-flight forks; kept in `_internal` (not part of `GET /api/state`). Fine.
- `POST /api/trunk/init` returns a fresh `token` every call (contract says
  `{repo, remote, token}`) — idempotent, no state change besides commit
  refresh.
- `GET /api/entries/:id` "re-forked since the agent last fetched it" has no
  per-agent identity in the contract; implemented per-entry `seenRepo`
  (single-actor assumption, see above).
- Contract's `ArbEvent` union excludes `snapshot`, yet requires it as the
  first WS message — implemented literally (snapshot sent unlisted type).

## Known gaps

- **DO version pinning:** a Durable Object with a continuously firing alarm
  (~3s cadence) stayed on the previous deployment *indefinitely* during T8
  (alarm keeps it warm; `/api/reset` didn't clear `trunk.repo` so the alarm
  chain survived). Worked around by bumping the DO name on deploy — each
  bump spawns a fresh object on the new deployment; old objects become
  harmless zombie pollers. T14 renamed everything again (`router-t14`,
  `trunk-t14`, `comp-e*` — the old `default-t11` may still poll inertly).
- Persisted-state shape changes need the constructor's `_internal`
  forward-fill (`{...initialState()._internal, ...stored}`); without it an
  old stored object crashes new code paths (`repoAlias` bug, fixed).
- **Stale-check resurrection (fixed, T8):** a `check.done` landing after
  the entry had already retired/squashed reset `status = "ready"` and
  re-triggered retirement → squash livelock. Fixed by applying check
  results only to `ready`/`checking` entries and keeping candidate-check
  results out of `e.checks`.
- **`retire.overlap` reforks from trunk**, not the producer: the collision
  is with trunk, so the retry must rebase onto it or livelock is inherent
  once the producer has retired.
- **`web-tree-sitter` + `nodejs_compat`:** Emscripten detects
  `process.versions.node` and takes its Node branch
  (`createRequire(import.meta.url)`); `import.meta.url` is undefined in the
  bundled Worker → crash. `app/hasher` shims `process.type = "renderer"`
  during `Parser.init` only when `import.meta.url === undefined` (Node
  tests unaffected).
- Effect failures (e.g. fork throwing) surface as 500/queue retry; a
  persistently failing fork leaves `pending` set until a later push reuses
  it — acceptable for the demo, no automatic unjam yet.
- Entries ignore ALL pushes while a fork/re-fork is pending (old repo, or a
  stale repo sharing the planned name); work pushed in that window must be
  redone on the new fork (T9c: tightened from old-repo-only).
- `ArbTrunk` keeps polling trunk forever while its repo is set (by design);
  component alarms stop once all their entries retire. Disable via
  `POLL_FALLBACK=off`.
- Wrangler warns the `CompiledWasm` rule needs an explicit `fallthrough`;
  deploy succeeds regardless (default rule ignored is harmless here).
