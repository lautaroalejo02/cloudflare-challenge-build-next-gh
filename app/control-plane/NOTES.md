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
- `test/rob.test.ts` — 11 node:test cases (run with
  `node --experimental-strip-types`, Node 22.15): forwarding, early cutoff,
  squash + diagnosis, transitive squash, in-order retirement (head only),
  failing check + retry on next push, robSize 409, veto + transitive
  dependents, veto non-head 409, reset, push dedupe/unknown-repo,
  pending-refork dedupe.
- `src/ports.ts` — port interfaces + implementations:
  - `ArtifactsPort` — real, wraps the `ARTIFACTS` binding (create / fork /
    token / log / readTree). `readTree` walks the commit's root tree
    recursively via `readCommit` -> `treeHash` -> `readTree` and returns every
    `.ts` file as `path -> source` (spike 1/3 code shape, disposable handles).
  - `HasherPort` — stub: regex over `export function|class|const|interface|type|enum`
    lines, sha256-12 hashes, same `InterfaceHash` shape as `app/hasher` so T8
    swaps interface-only.
  - `CheckerPort` — stub that passes.
  - `RetirerPort` — stub that returns the entry head commit; the DO records it
    in `trunk.commit` via `retire.done` (real ff-retirer: T7/T8).
- `src/do.ts` — `ReorderBuffer` DO, one instance `idFromName("default")`.
  State persisted in DO storage (`state`, `seenGen` keys). Executes effects
  through ports; broadcasts events to WebSockets via the hibernation API
  (`ctx.acceptWebSocket`, snapshot on connect). DO alarm polls every ~3s
  (spike 2b) over trunk + live entry repos when `POLL_FALLBACK != "off"`;
  dedupes against queue events by `repo:commit` and `headCommit`.
- `src/index.ts` — Worker: `/api/*` -> DO fetch, queue consumer ->
  `stub.onPush(repo, after)` filtered to `cf.artifacts.repo.pushed` on
  `refs/heads/main` in namespace `arb`, everything else -> `env.ASSETS`.
- `wrangler.toml` — name `arb-control-plane`, artifacts `arb`, DO migration
  `new_sqlite_classes: [ReorderBuffer]`, queue consumer `arb-push-events`
  (`max_batch_timeout=1`), assets `../dashboard` with `run_worker_first` +
  `ASSETS` binding, vars `POLL_FALLBACK=on`, `POLL_INTERVAL_MS=3000`.
- `scripts/setup.sh` — creates queue + namespace-wide event subscription.

## Run / test / deploy

```sh
npm install
npm test                 # 11 state-machine unit tests, no CF needed
npx tsc --noEmit         # typecheck
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
- **Token on `GET /api/entries/:id`**: DO keeps `seenGen[id]`; a fresh 1h
  token is returned iff `entry.generation > seenGen[id]` (i.e. re-forked
  since last fetch), then `seenGen` is updated.
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
  retried as `arb-e<seq>-<lane>-<n>-x<k>` (k=1..9) and
  `_internal.repoAlias[planned] = actual` lets already-emitted dependent
  refork effects resolve the real source name. A run-epoch component in the
  contract naming scheme would remove the need for this.
- `Entry.status` has no `retiring` state and `Entry` has no field for
  in-flight forks; kept in `_internal` (not part of `GET /api/state`). Fine.
- `POST /api/trunk/init` returns a fresh `token` every call (contract says
  `{repo, remote, token}`) — idempotent, no state change besides commit
  refresh.
- `GET /api/entries/:id` "re-forked since the agent last fetched it" has no
  per-agent identity in the contract; implemented per-entry `seenGen`
  (single-actor assumption, see above).
- Contract's `ArbEvent` union excludes `snapshot`, yet requires it as the
  first WS message — implemented literally (snapshot sent unlisted type).

## Known gaps

- **DO version pinning:** a Durable Object with a continuously firing alarm
  (~3s cadence) stayed on the previous deployment for ~2 minutes after
  `wrangler deploy` — observed live: requests served by the old
  `scriptVersion` until eviction. Expect deploy propagation lag on API
  behavior changes; verify `scriptVersion` via `wrangler tail` if responses
  look stale.
- Persisted-state shape changes need the constructor's `_internal`
  forward-fill (`{...initialState()._internal, ...stored}`); without it an
  old stored object crashes new code paths (`repoAlias` bug, fixed).
- Hasher/checker/retirer are stubs (T8 wires `app/hasher`, `app/checker`,
  T7's retirer). Stub retirer does not write to `arb-trunk`, so
  `trunk.commit` is a pointer record only — the alarm poll can revert it to
  the repo's real head (observed after reset).
- Effect failures (e.g. fork throwing) surface as 500/queue retry; a
  persistently failing fork leaves `pending` set until a later push reuses
  it — acceptable for the demo, no automatic unjam yet.
- `squashed` entries whose refork is in flight ignore pushes to the old
  repo name; work pushed to the stale fork in that window must be redone.
- Alarm keeps polling trunk forever while `trunk.repo` is set (by design);
  disable via `POLL_FALLBACK=off`.
