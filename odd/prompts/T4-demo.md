First read `odd/prompts/_builder_head.md` completely and follow every rule in it. Then do the task below.

# Task T4: `app/demo`, fixture app, scripted agents and scenario runner (Node, local, against the control-plane HTTP API)

## Allowed edit surfaces
app/demo/**

## Requirements
- `app/demo/fixture/`, per "Fixture convention" in CONTRACTS:
  - `src/api/order.ts` v1 exports `createOrder(cart: Cart, region: string): Order` plus types `Cart`, `Order`, `LineItem`.
  - `src/ui/checkout.ts` renders a checkout summary string using `createOrder`.
  - `tests/order.test.ts` exports `run()`.
  - Tiny and deterministic.
- Scripted agents in `src/agents/*.ts`, run with `node --experimental-strip-types` (or `tsx` if needed). Each agent is a small state machine using the HTTP API in CONTRACTS:
  1. Register an entry.
  2. `git clone` its fork with the token URL (CONTRACTS naming/auth) into `app/demo/tmp/<entry>-g<generation>`.
  3. Apply its scripted edits (file writes), commit, push.
  4. Poll `GET /api/entries/:id` every 1s.
  5. When `generation` increases (squash), re-clone the new fork, re-apply its work ADAPTED to the diagnosis, and push again.
  6. Mark ready.
- API agent (producer, lane "api"):
  - Step 1: a body-only refactor of `createOrder`. This must produce an early cutoff, not a squash.
  - Step 2, about 10s later: the breaking change `createOrder(cart: Cart, opts: { region: string; currency: string }): Order`.
- UI agent (lane "ui", producerId = API entry, consumes ["createOrder", "Order"]):
  - Adds a checkout feature that calls createOrder.
  - Has a v1 edit and a v2 edit, and picks the one matching the producer's current signature (read the file in its clone).
- Tests agent (lane "tests", producerId = API entry, consumes ["createOrder"]):
  - Adds tests for the new feature.
  - Also signature-aware.
- Adaptation is deterministic (scripted per signature), NOT an LLM. Label it clearly as mocked agent intelligence in NOTES.md.
- `src/scenario.ts`, run via `npm run demo -- --base <control-plane URL>`:
  1. Calls `/api/reset`, then `/api/trunk/init`, and pushes the fixture to trunk.
  2. Starts the three agents concurrently with realistic staggered timing.
  3. Prints a timeline.
  4. Exits 0 when all three entries are `retired`. Timeout: 5 minutes.
- `--scenario failing-check`: the Tests agent first pushes a failing test. The entry must not retire. Then the agent fixes it.
- `src/mock-server.ts`: a tiny local mock of the control-plane API, so the agents' state machines can be tested without Cloudflare. Use it in automated tests for squash handling, generation change, and re-clone path logic. A local bare git repo is fine for the mock.
