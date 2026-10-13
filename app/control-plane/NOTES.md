# arb-control-plane — NOTES

Worker + `ReorderBuffer` Durable Object + queue consumer + HTTP/WS API.
Deployed: `https://arb-control-plane.lautitomasalejo.workers.dev`

## What was built

- `src/rob.ts` — pure reorder-buffer state machine (no Cloudflare imports).
  `apply(state, cmd, now)` mutates and returns `{ state, effects }` where
  effects are fork / token / check / retire / broadcast requests executed by
  the DO. Internal bookkeeping (`_internal`: signature texts, in-flight
  forks, check/retire dedupe, push dedupe, event log) is persisted but
  stripped from `GET /api/state` via `publicState()`.
- `test/` — 26 node:test cases (run with `node --experimental-strip-types`,
  Node 22.15): `rob.test.ts` state machine (forwarding, early cutoff, squash
  + diagnosis, transitive squash, in-order retirement, failing check +
  retry, robSize 409, veto + transitive dependents, veto non-head 409,
  reset, push dedupe/unknown-repo, pending-refork dedupe, splice/overlap
  retire plan, stale-plan drop, no-op ready on squashed refork),
  `splice.test.ts` pure path-disjoint decision, `retire.test.ts` git-level
  fast-forward/splice/already-on-trunk on `MemFs` + isomorphic-git.
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
- `src/do.ts` — `ReorderBuffer` DO. State persisted in DO storage.
  Executes effects through ports; broadcasts events to WebSockets via the
  hibernation API (`ctx.acceptWebSocket`, snapshot on connect). DO alarm
  polls every ~3s (spike 2b) over trunk + live entry repos when
  `POLL_FALLBACK != "off"`; dedupes against queue events by `repo:commit`
  and `headCommit`. `GET /api/events` exposes the ring-buffer event log.
- `src/index.ts` — Worker: `/api/*` -> DO fetch, queue consumer ->
  `stub.onPush(repo, after)` filtered to `cf.artifacts.repo.pushed` on
  `refs/heads/main` in namespace `arb`, everything else -> `env.ASSETS`.
- `wrangler.toml` — name `arb-control-plane`, artifacts `arb`, DO migration
  `new_sqlite_classes: [ReorderBuffer]`, queue consumer `arb-push-events`
  (`max_batch_timeout=1`), assets `../dashboard` with `run_worker_first` +
  `ASSETS` binding, `nodejs_compat`, `worker_loaders` `LOADER`, rules
  `CompiledWasm` for `tree-sitter.wasm`, vars `POLL_FALLBACK=on`,
  `POLL_INTERVAL_MS=3000`.
- `scripts/setup.sh` — creates queue + namespace-wide event subscription.

## Run / test / deploy

```sh
npm install
npm test                 # 26 unit tests (state machine + splice + git), no CF needed
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

## Cloudflare resources created

- Worker `arb-control-plane` (DO `ReorderBuffer`, migration v1 sqlite).
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
  chain survived). Worked around by bumping `DO_NAME` in `src/index.ts`
  (`default-t8*` — each bump spawns a fresh object on the new deployment;
  old objects become harmless zombie pollers). Before reverting to
  `default`, make `/api/reset` clear `trunk.repo` so the alarm chain dies.
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
- `squashed` entries whose refork is in flight ignore pushes to the old
  repo name; work pushed to the stale fork in that window must be redone.
- Alarm keeps polling trunk forever while `trunk.repo` is set (by design);
  disable via `POLL_FALLBACK=off`.
- Wrangler warns the `CompiledWasm` rule needs an explicit `fallthrough`;
  deploy succeeds regardless (default rule ignored is harmless here).
