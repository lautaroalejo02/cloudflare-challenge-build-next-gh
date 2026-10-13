First read `odd/prompts/_builder_head.md` completely and follow every rule in it. Then do the task below.

# Task T6: `app/control-plane`, Worker + ReorderBuffer Durable Object + queue consumer + API (the core mechanism)

## Allowed edit surfaces
app/control-plane/**

## Requirements
- **Pure state machine first.** `src/rob.ts` has no Cloudflare imports and is unit-tested (node:test or vitest), test-first. It takes commands/events and returns new state plus effects (fork requests, token requests, check requests, retire requests, broadcast events). Cover:
  - forwarding: the consumer forks the producer's head;
  - early cutoff when a consumed hash is unchanged;
  - squash with diagnosis when a consumed hash changes;
  - transitive squash;
  - in-order retirement: head only, producer retired, ready, checks passed;
  - a failing check blocks retirement, and the next push retries;
  - robSize admission (409);
  - veto squashes transitive dependents;
  - reset.
- **Durable Object `ReorderBuffer`.** One instance named "default"; the design allows one per connected component. Persist state in DO storage. Execute effects through ports. Broadcast events over WebSockets (hibernation API).
- **Ports (`src/ports.ts`)**, so integration can swap implementations:
  - `ArtifactsPort` (create/fork/token/readTree/log): real, using the binding; reuse spike 1/3 code.
  - `HasherPort` (`hashInterface(files)`): a stub for now (naive regex over `export function` lines). The real one comes from `app/hasher` in task T8.
  - `CheckerPort` (`runChecks`): a stub that passes.
  - `RetirerPort` (`fastForward({ fromRepo, commit, toRepo, branch })` → new trunk commit): a stub that records the pointer in DO state. The real one comes from task T7.
  - Do NOT import `app/hasher` or `app/checker` yet; T8 wires them.
- **Push events.**
  - A queue consumer for `cf.artifacts.repo.pushed` calls DO.onPush, which: maps repo → entry, reads the changed `.ts` files at the new commit, hashes them, compares, then squashes or cuts off.
  - Subscriptions: create per-fork repo-scoped subscriptions via the REST API from the Worker if possible. Otherwise document a namespace-wide subscription created once by a setup script (`scripts/setup.sh`). Reuse the spike 2a learnings (Wrangler >= 4.149).
  - Also add a DO alarm poll fallback (spike 2b) over active entries' forks, behind a config flag that defaults to on. If both fire, dedupe by commit.
- **API.** HTTP API and WS exactly per CONTRACTS. Serve `app/dashboard` as static assets (Workers static assets config pointing at `../dashboard`). If that folder is still empty when you finish, keep the config and note it.
- **Deploy** as `arb-control-plane` with Artifacts namespace `arb`, queue `arb-push-events`, and the DO migration.
- **Smoke test with curl**, and record results in NOTES.md:
  1. `trunk/init` (push a tiny fixture with git);
  2. create an API entry and a UI entry forwarded from it;
  3. push to the API fork with git;
  4. observe `push` and `hash.*` events or stats in `/api/state`.
