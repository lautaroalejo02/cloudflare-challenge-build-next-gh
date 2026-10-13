# app/demo — fixture app, scripted agents, scenario runner, local control-plane mock

Demo package for the Agent Reorder Buffer (ARB). Everything runs on plain Node
(v22.15) with `node --experimental-strip-types`; zero npm dependencies.

## What was built

- `fixture/` — the tiny deterministic demo repo that gets pushed to `arb-trunk`:
  - `src/api/order.ts` — v1 `createOrder(cart: Cart, region: string): Order`
    plus `Cart`, `Order`, `LineItem` types.
  - `src/ui/checkout.ts` — `renderCheckoutSummary` calling `createOrder`.
  - `tests/order.test.ts` — self-exports `run()` per the checker convention
    (`tests/**/*.test.ts`). Only totals are asserted, so the baseline stays
    green across the v1 → v2 signature migration.
- `src/agents/` — three scripted agents sharing one state machine (`base.ts`):
  register → clone token-URL fork into `tmp/<entry>-g<generation>` → apply
  scripted edits → commit → push → mark ready → poll `GET /api/entries/:id`
  every 1 s → on `generation` increase (squash) re-clone the new fork with the
  fresh `token` from the GET response and re-apply work adapted to the
  diagnosis; on `failed` checks apply a scripted fix.
  - `api.ts` — producer, lane `api`. Step 1 is a body-only refactor (extracts a
    private `sumCart` helper, identical exported interface → early cutoff).
    Step 2 (~10 s later) is the breaking change
    `createOrder(cart: Cart, opts: { region: string; currency: string }): Order`
    (`Order` gains `currency`; EUR totals convert at 92%).
  - `ui.ts` — lane `ui`, `consumes: ["createOrder", "Order"]`. Adds a
    `renderExpressCheckout` feature; picks the v1/v2 edit variant by sniffing
    the producer signature in its fresh clone (`lib/signatures.ts`).
  - `tests.ts` — lane `tests`, `consumes: ["createOrder"]`. Adds
    `tests/create-order.feature.test.ts`; also signature-aware.
- `src/scenario.ts` — `npm run demo -- --base <URL> [--scenario main|failing-check]`:
  `POST /api/reset` → `POST /api/trunk/init` → pushes `fixture/` to trunk →
  starts the three agents staggered → prints a timeline (agent actions plus
  buffer status/stat transitions) → exits 0 when all three entries are
  `retired`, non-zero on failure or after the 5-minute timeout.
- `src/mock-server.ts` — a local mock of the whole control-plane HTTP API so the
  agent state machines are testable without Cloudflare (details below).
- `test/agent.test.ts` — `npm test`: fixture sanity, full main scenario
  (early cutoff → 2 squashes → generation bumps → re-clone dirs → in-order
  retirement → trunk contents), failing-check scenario, robSize 409, veto
  head-only.

## Mocked agent intelligence

The "intelligence" is 100% deterministic scripting, per the task. There is no
LLM anywhere: adaptation to a squash = `detectCreateOrderVersion()` regex over
`src/api/order.ts` in the re-cloned fork, choosing between two pre-written file
variants. The failing-check "fix" is likewise a pre-written variant swap.

## Mock control plane (`src/mock-server.ts`)

Deliberately a mock — useful for agent state-machine tests, not a reference
implementation of the real ReorderBuffer DO:

- Repos are local bare git repos (`<root>/repos/*.git`); `remote` is a
  `file://` URL and `token` is a dummy string (`authUrl()` passes `file:`
  remotes through unauthenticated).
- Push detection is a `rev-parse refs/heads/main` poll (default 100 ms) instead
  of `cf.artifacts.repo.pushed` queue events.
- Exported-interface hashing is a small regex extractor + sha256 (NOT the real
  web-tree-sitter hasher); normalization collapses whitespace and ignores
  function bodies, so the body-only refactor keeps its hash.
- Checks clone the commit and `import()` each `tests/**/*.test.ts` in-process,
  calling `run()` — same convention as the Dynamic-Worker checker.
- Retirement merges each entry head into a trunk work clone with `-X theirs`
  (the real retirer fast-forwards). The merge unions disjoint changes so the
  final trunk tree contains all three agents' work.
- `GET /api/ws` returns 501; the scenario timeline polls `/api/state` instead.
- Deviations from contract, by design: `POST /api/reset` deletes entry fork
  repos (they are disposable local dirs; keeps names reusable — the real
  contract keeps remote repos); `headCommit` on a fresh fork equals the source
  head (the fork literally contains that commit).
- All state mutations (push detection, squash, ready/check, retire, veto)
  serialize through a single promise queue so concurrent HTTP handlers and the
  poll tick cannot double-apply transitions.

Stat semantics: `earlyCutoffs` counts pushes that squashed nothing — i.e. the
exported interface was unchanged (body-only edit) or no consumed symbol
changed. So the api refactor counts, and interface-unchanged consumer pushes
count too.

## How to run

```bash
# against the deployed control plane
npm run demo -- --base https://arb-control-plane.<account>.workers.dev

# locally, no Cloudflare
npm run mock -- --port 8899 --root tmp-mock/live   # terminal 1
npm run demo -- --base http://127.0.0.1:8899        # terminal 2
npm run demo -- --base http://127.0.0.1:8899 --scenario failing-check

# tests
npm test
```

Expected timeline (main scenario): api refactor push → early cutoff; consumers
work speculatively on the forwarded fork; ~10 s later api pushes the breaking
change → both consumers squashed (`generation` 0→1, diagnosis with old/new
signatures) → they re-clone `arb-e<seq>-<lane>-1`, detect v2, apply the v2
variants, re-push → checks pass → entries retire e1 → e2 → e3 onto trunk.
Verified locally: `{"squashes":2,"earlyCutoffs":4,"retired":3}` in ~23 s.

## Decisions taken

- Agents run under `node --experimental-strip-types` (no tsx dep); all sources
  are erasable-syntax-only TS (no parameter properties, enums, namespaces).
- Clone dirs are `tmp/run-<id>/<entryId>-g<gen>` — unique per run because
  entry ids restart at e1 after `/api/reset` — and are recreated per
  generation; the old `-g0` clone is kept so a squash visibly produces a new
  workdir. All of `tmp/` is wiped at scenario start.
- Ready-posting races a squash: the agent re-checks `generation` before each
  scripted step and treats a 409 `stale commit` on `/ready` as "loop and
  re-read state" — the mock 409s when the posted commit is not the current
  head.
- `file://` remotes (mock) skip token auth in `authUrl`; `https://` remotes get
  `x:<token>@` with the `?expires=` suffix stripped, per CONTRACTS.
- Entry fork naming starts at `-0` to mirror `generation` (`arb-e1-api-0`,
  re-forks `arb-e1-api-1`, …).

## Contract issues

- `GET /api/entries/:id` returning `{entry, token?}`: the contract says a fresh
  token is included "when the entry was re-forked since the agent last fetched
  it". The mock implements this as a one-shot `tokenPending` flag set on every
  re-fork and cleared when included in a response. Agents fall back to the
  registration token if no fresh token arrives.
- `POST /api/entries/:id/ready` semantics on a stale commit are unspecified;
  the mock returns 409 `{error: "stale commit: ..."}` when `commit !==
  headCommit`, and the agents treat a rejected ready as transient.
- Status after a successful check is unspecified; the mock uses `ready`
  (= marked ready AND checks passed) so the in-order retirement sweep can
  retire directly from `ready`.
- Retirement onto a trunk whose head is not an ancestor of a consumer's fork
  (e.g. after an early-cutoff producer push) cannot be a git fast-forward; the
  mock works around it with a `-X theirs` merge. The real retirer needs a
  rebase/splice strategy here — worth checking in T7/T8.

## Cloudflare resources created

None — this package is local-only by design.

## Live run (T9c)

Against `https://arb-control-plane.lautitomasalejo.workers.dev` (deployed
2026-10-13, version `3700ee7d`).

Defects found by the orchestrator's live run (`odd/logs/parent-e2e.txt`) and
their root causes / fixes:

1. **Process hang** — the run finished at +40.5s but the process exited only
   at ~311s. Cause: the 5-minute `setTimeout` behind `Promise.race` stayed
   pending after completion and kept the event loop alive. Fix: the timeout
   timer is now `unref`'d and `clearTimeout`ed on completion, and the runner
   flushes stdout/stderr then calls `process.exit(code)` — queued pipe writes
   can't be truncated and fetch keep-alive sockets can't delay the exit.
2. **Tests agent contributed nothing in generation 1** — e3 retired with head
   `6ea008d9` (= e1's head) after "nothing to commit ... already on base".
   Root cause found from `tmp/trunk-src` on disk: `arb-trunk` persists across
   runs (`/api/reset` does not delete repos) and the previous run's retired
   `tests/create-order.feature.test.ts` (v2 variant) was still on trunk. The
   seeder copied the fixture *over* the old worktree, so the stale file rode
   into seed commit `0419d445`, then into every fork — the gen-1 rewrite was
   byte-identical. Fixes: (a) `syncFixture` (`src/lib/fixture.ts`) deletes
   every non-`.git` entry before copying, so the seed is exactly the fixture;
   (b) clone dirs moved to run-unique `tmp/run-<id>/<entry>-g<gen>` and `tmp/`
   is still wiped at scenario start; (c) control-plane `rob.ts` now ignores
   ALL pushes to an entry while its (re)fork is pending — a stale repo sharing
   the planned fork name could previously inject its head/exports mid-flight
   (same class of aliasing, covered by a new `rob.test.ts` case).
3. **Misleading dashboard stat** — "squash after push" was ~0ms live (the DO
   stamps the producer push and consumer squashes in one `apply`). Replaced by
   "re-fork ready": `refork.ts − squash.ts` of the entry's latest squash, an
   honest server-side latency (read 4.1 s live; 1.3 s in the mock replay —
   e3 squash at 7150 → refork at 8400).

### Main scenario — exit 0, complete +38.0s, process exit ~1.2s later (wall 39.2s)

```
[+   0.3s] [scenario] POST /api/reset ok
[+   2.8s] [scenario] fixture pushed to trunk at b96ad7d5
[+   5.3s] [api     ] registered e1 seq=1 lane=api repo=arb-e1-api-0-x16
[+  13.9s] [api     ] pushed 87b73c82 "refactor(api): extract sumCart helper from createOrder" (gen 0)
[+  15.2s] [tests   ] pushed 8ed60577 "test: add createOrder feature coverage" (gen 0)
[+  25.1s] [api     ] pushed f24a302d "feat(api)!: createOrder now takes { region, currency } options" (gen 0)
[+  27.2s] [buffer  ] stats.squashes 0 -> 2
[+  28.8s] [buffer  ] e1 (api) ready -> retired
[+  31.3s] [tests   ] cloning arb-e3-tests-1-x12 -> e3-g1 (generation 1)
[+  32.9s] [tests   ] detected createOrder signature v2 - writing v2 feature test
[+  34.3s] [tests   ] pushed 66b4f88d "test: reapply feature coverage for new createOrder interface" (gen 1)
[+  36.0s] [buffer  ] e2 (ui) ready -> retired
[+  36.8s] [buffer  ] e3 (tests) ready -> retired
[+  38.0s] [final   ] e1 api    status=retired gen=0 head=f24a302d
[+  38.0s] [final   ] e2 ui     status=retired gen=1 head=37bedada
[+  38.0s] [final   ] e3 tests  status=retired gen=1 head=66b4f88d
[+  38.0s] [final   ] stats={"squashes":2,"earlyCutoffs":2,"retired":3,"checksRun":4,"pushesSeen":6} trunk=015bee1d retired=3
[+  38.0s] [scenario] all three entries retired onto trunk in order - demo complete
EXIT_CODE=0 WALL_MS=39190
```

### `--scenario failing-check` — exit 0, complete +45.8s, exit ~0.8s later (wall 46.6s)

```
[+   0.3s] [scenario] POST /api/reset ok
[+   3.0s] [scenario] fixture pushed to trunk at 40c730db
[+  15.6s] [tests   ] pushed 0a352333 "test: add createOrder feature coverage" (gen 0)
[+  25.7s] [api     ] pushed 90ffecca "feat(api)!: createOrder now takes { region, currency } options" (gen 0)
[+  28.8s] [buffer  ] stats.squashes 0 -> 2
[+  30.4s] [buffer  ] e1 (api) ready -> retired
[+  36.4s] [tests   ] pushed b044f649 "test: reapply feature coverage for new createOrder interface" (gen 1)
[+  39.3s] [buffer  ] e3 (tests) speculating -> failed
[+  40.0s] [tests   ] checks failed (1 failing) - applying scripted fix
[+  42.5s] [buffer  ] e3 (tests) failed -> speculating
[+  44.9s] [buffer  ] e3 (tests) ready -> retired
[+  45.8s] [final   ] e1 api    status=retired gen=0 head=90ffecca
[+  45.8s] [final   ] e2 ui     status=retired gen=1 head=517943ed
[+  45.8s] [final   ] e3 tests  status=retired gen=1 head=5b405add
[+  45.8s] [final   ] stats={"squashes":2,"earlyCutoffs":2,"retired":3,"checksRun":5,"pushesSeen":7} trunk=f26c0ce2 retired=3
[+  45.8s] [scenario] all three entries retired onto trunk in order - demo complete
EXIT_CODE=0 WALL_MS=46617
```

Trunk check (`git clone` of `arb-trunk` main afterwards): the file is present
at head and was added by the tests agent's own commits, delivered via splice:

```
$ git log --format='%h %s' -- tests/create-order.feature.test.ts
f26c0ce arb: splice 5b405addec84ff70c90fc572ac7612da6d6fd9da onto 517943edb11ad571a1ef8280096063c664d3dd57
40c730d chore: seed fixture (order api, checkout ui, tests)
015bee1 arb: splice 66b4f88d05d7011678c324eca6b9d778814bf380 onto 37bedadaa4c12f128822762cca18ede4d6843120
b96ad7d chore: seed fixture (order api, checkout ui, tests)
6bede76 arb: splice 29d64510c4cf64fc548305b8a31602779242a530 onto 8f465f0452e01cca8befa5c89a2e029c2de182df
...
```

(`015bee1` splices the main run's e3 head `66b4f88d`; `f26c0ce` splices the
failing-check run's e3 head `5b405add`; the `chore: seed fixture` entries are
the seeder deleting the previous run's stale file — now a true reset.)

Live dashboard captures (headless Edge, 1920x1080):
`app/dashboard/screenshots/live-squash.png` (e2 SQUASHED with the v1→v2
diagnosis) and `live-final.png` (all three entries retired, "re-fork ready
4.1 s").

## Known gaps

- No WebSocket client; the timeline polls `/api/state` every 800 ms.
- The mock's signature extractor only handles the fixture's declaration shapes
  (exported functions, interfaces, type aliases, consts) — it is not the real
  hasher and must not be reused as one.
- Depth-2 dependency chains in the mock resolve on the intermediate entry's
  next push rather than eagerly; fine for the 3-entry demo.
- `npm run demo` wipes `app/demo/tmp/` at start; the mock must use a root
  outside `tmp/` when run alongside it.
