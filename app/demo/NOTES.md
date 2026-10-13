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
- Clone dirs are `tmp/<entryId>-g<gen>` and are recreated per generation; the
  old `-g0` clone is kept so a squash visibly produces a new workdir.
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

## Known gaps

- No WebSocket client; the timeline polls `/api/state` every 800 ms.
- The mock's signature extractor only handles the fixture's declaration shapes
  (exported functions, interfaces, type aliases, consts) — it is not the real
  hasher and must not be reused as one.
- Depth-2 dependency chains in the mock resolve on the intermediate entry's
  next push rather than eagerly; fine for the 3-entry demo.
- `npm run demo` wipes `app/demo/tmp/` at start; the mock must use a root
  outside `tmp/` when run alongside it.
