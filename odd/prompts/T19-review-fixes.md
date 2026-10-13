First read `odd/prompts/_builder_head.md` completely and follow every rule in it. Then do the task below. Another agent edits ONLY `README.md` and `docs/**` in parallel and runs no live scenarios; do not touch those files. You are the only agent changing app code and running live scenarios.

# Task T19: Fix the findings of the independent review

## Allowed edit surfaces
app/control-plane/**
app/checker/**
app/demo/**
app/dashboard/**
app/CONTRACTS.md

## Findings to fix, in priority order
An independent reviewer read the code. Paths are relative to `app/control-plane/` unless stated otherwise. For every CONFIRMED finding, first write a failing regression test (RED), then fix it (GREEN). Where a test is impossible (DO I/O), explain why and add the closest pure-logic test.

1. **(High) Auth for destructive and token-minting endpoints.**
   - Today these are all unauthenticated: `POST /api/trunk/init` hands any caller a 1-hour write token for `arb-trunk`, and `/api/reset`, `/api/config` and `/api/entries/:id/veto` are open. `robSize` also survives reset (`src/router.ts:239-240`, `src/rob.ts:1041-1047`).
   - Add an `ARB_ADMIN_KEY` Worker secret:
     - In `src/index.ts`, every non-GET `/api/*` request, and `GET /api/entries/:id` (which can return tokens), needs header `x-arb-key` matching it; otherwise 403.
     - Keep `GET /api/state`, `/api/events` and `/api/ws` public.
     - Reset also restores `robSize` to its default.
   - Generate a random key and set it with `npx wrangler secret put ARB_ADMIN_KEY` (pipe the value in).
   - Store the key ONLY in `app/control-plane/.secret-admin-key`, which is gitignored by the root `.gitignore` `.secret*` rule. Never commit or print it.
   - The demo CLI reads `ARB_ADMIN_KEY` from the environment, or from that file by default.
   - The dashboard hides VETO and robSize controls unless `?key=` is present, in which case it sends the header.
   - Document in `app/control-plane/NOTES.md` how to set and use the key, without the value.
2. **(High) Transient infra failures are treated as permanent check failures.**
   - `app/checker/src/index.ts:66-68` turns any infra error into a failed CheckResult.
   - Re-readying the same commit never re-checks (`src/rob.ts:498-522`).
   - `src/atomic.ts:42-78` / `src/rob.ts:942-959` retry with no backoff.
   - Fix:
     - Mark infra failures distinctly, e.g. a CheckResult flag `infra: true` (add a CONTRACTS changelog line), and do not store them as the entry's verdict.
     - `entry.ready` clears a failed `checks` verdict so a re-ready re-checks.
     - Add backoff of about 0.5 s / 1 s / 2 s between atomic attempts.
     - Make Artifacts reads in the checker and retirer retry 5xx with backoff.
3. **(High) A failed effect wedges the component.**
   - `src/do.ts:178-219`: the effect queue aborts on the first throw. The token and fork effects have no catch. Router rollback is router-only (`src/router.ts:151-156`).
   - Fix:
     - Use per-effect try/catch so the queue continues.
     - On fork failure, record it and let `alarm()` re-issue it.
     - Add an alarm sweep that clears `pending`/`checking`/`retiring` markers older than about 60 s and re-runs cascade.
     - Emit visible events for each recovery.
4. **(High) A squash is lost when the producer pushes during the consumer's in-flight fork** (reproduced).
   - `src/rob.ts:785-788`, `:820-825`, `:657-660`.
   - Fix: in `fork.done`, compare each consumed symbol against `find(producerId).exports`. If any differs (including a pending prediction pin), squash and re-fork immediately.
5. **(Medium) A veto during an in-flight retire gets overridden** (reproduced).
   - Fix: 409 for a veto while `retiring[e.id]` is set. Guard `retire.done` and `retire.overlap` on `retiring[e.id]` and on the entry status.
6. **(Medium) A push during a retire desyncs trunk and buffer** (`src/rob.ts:714-719`, `:992`; the test at `test/rob.test.ts:643-657` encodes the bug).
   - Fix: when `retire.done` is stale, set `e.baseCommit = cmd.entryCommit` and `state.trunk.commit = cmd.commit`. Update that test.
7. **(Medium) Splice disjointness misses file/dir conflicts and loses info** (reproduced).
   - `src/splice.ts:14-18` uses exact-string compares. `src/retire.ts:288-289`, `:307`.
   - Fix:
     - Overlap when paths are equal OR one is a directory prefix of the other.
     - Record both sides on a blob↔tree type change.
     - Compare `mode` as well as oid.
     - Keep non-blob entries (gitlinks).
8. **(Medium) A re-fork token is handed out once to whoever asks first** (`src/do.ts:479-486`). With the key from #1 in place, return a fresh token on every authenticated GET.
9. **(Medium) Out-of-order push handling can regress head** (PLAUSIBLE; `src/do.ts:333-351`). After hashing, re-read `log(repo, 1)` and drop the event if the commit is no longer the head.
10. **(Medium) Ops.**
    - Bump the DO instance names (`TRUNK_NAME`, router, component prefix) as part of this deploy; read NOTES on alarm pinning.
    - Stop the trunk alarm when idle.
    - Keep `nextSeq` monotonic across resets (or use a random suffix on the first collision) to avoid up to 19 failing `-xN` forks.
11. **(Low, if time allows)**
    - Serialize router creates with a promise queue (`src/router.ts:133-137`).
    - Release `predConsumed` when a stubbed producer is vetoed.
    - Diff grandchildren against their direct producer in cascaded squash diagnoses (`src/rob.ts:473-484`).
    - Sanitize the error strings at `src/do.ts:252` and `:315` (no stack traces in state/events).

## Verification
- `npm test` in control-plane, checker, demo and dashboard is green; run the demo suite 3 times.
- Deploy.
- Live, against `https://arb-control-plane.lautitomasalejo.workers.dev`, with the admin key from `.secret-admin-key`:
  - main exits 0;
  - failing-check exits 0;
  - multi exits 0, 3 times.
- Prove auth: `curl -X POST .../api/reset` without the key must return 403, and with the key 200. `GET /api/state` must be 200 without the key.
- Record everything in `app/control-plane/NOTES.md` under "Review fixes (T19)", with a table: finding → fix → test name → status. Mark any finding you did not fix as deferred, with the reason.

## Safety net
- Last known-good: git tag `demo-stable-3`, Worker version `4e0fdc50-cd9f-4cbd-9adc-95a11cedf52d`.
- If, at the end of your time box, main and failing-check do not both pass:
  1. Roll back with `npx wrangler rollback 4e0fdc50-cd9f-4cbd-9adc-95a11cedf52d`.
  2. Delete the `ARB_ADMIN_KEY` secret only if the rolled-back version would break with it present. It will not: the old code ignores it.
  3. Verify main passes.
  4. Report `partial`.
