First read `odd/prompts/_builder_head.md` completely and follow every rule in it. Then do the task below. Another agent edits `README.md` and `docs/**` in parallel; do not touch those. Do not redeploy the control plane.

# Task T15: Restore the early-cutoff scene and fix a flaky demo test

## Allowed edit surfaces
app/demo/**

## Evidence (from the orchestrator's runs)
1. **Regression after value prediction (T11).**
   - The live main scenario now ends with `"earlyCutoffs":0`; before T11 it was 2. See log `odd/logs/parent-e2e-4.txt`.
   - Acceptance criterion 2 in `odd/tasks/agent-reorder-buffer.md` requires a body-only producer push that causes no squash (an early cutoff, visible in stats).
   - The API agent's body-only refactor probably no longer lands as its own push after the stub-resolving push.
   - Fix the scripted API agent timeline so the live main scenario shows, in order:
     1. the stub prediction resolution (2 hits / 1 miss, unchanged);
     2. a body-only refactor push → early cutoff for its consumers (`earlyCutoffs ≥ 1`, no squash);
     3. the breaking change → squashes.
   - Keep `--scenario failing-check` working.
2. **Flaky test.**
   - `npm test` in `app/demo` fails about 1 run in 4 at `failing-check scenario: failing test blocks retirement until fixed` (test/agent.test.ts:161), with `e2 checks keep failing` thrown from `src/agents/base.ts:161`.
   - Find the root cause (likely a race in `src/mock-server.ts` or in the agent's v1/v2 variant choice around squash/prediction timing) and fix it deterministically. Do not just raise timeouts or retries.
   - Prove the fix: run `npm test` 10 times in a row with 0 failures. Report the count.

## Verification
- `npm test` passes 10/10 consecutive runs.
- Live: `npm run demo -- --base https://arb-control-plane.lautitomasalejo.workers.dev`. It must exit 0, with stats showing `earlyCutoffs ≥ 1`, `predictionHits ≥ 1`, `predictionMisses ≥ 1`, `squashes ≥ 1` and `retired = 3`. Also run `--scenario failing-check` and confirm exit 0.
- Update `app/demo/NOTES.md` with the cause, the fix and the final live stats.
