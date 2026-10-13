Read `odd/prompts/_builder_head.md` and follow its rules. Also read `odd/tasks/arb-v2.md` (the V4 entry and its known gap), the "(V2)" items in `app/CONTRACTS.md`, and `app/control-plane/NOTES.md` sections "V3b audit fixes" and "V2 integration (V4)". You are the only agent changing code, deploying and running live scenarios now.

# Task V8: Restrict dependency inference to files the entry changed

## Allowed edit surfaces
app/control-plane/**
app/demo/**
app/CONTRACTS.md

## Problem (observed live in V4)
Inference runs `extractImports` over the entry's whole tree, so imports in files the agent never edited become `consumes`. Live, the UI entry inferred `[createOrder, Cart, charge]`, but `charge` comes from `src/ui/paywall.ts`, an untouched trunk file. That causes needless Jev calls and possible false squashes, and the timeline is no longer honest.

## Change
1. Inference considers only `ImportRef`s whose importing `file` changed in the entry relative to its `baseCommit`: added or modified content, by blob oid. V3b's usage selection already computes "consumer files changed relative to baseCommit" in `src/effects.ts`/`src/do.ts`. Reuse that diff, do not write a second one.
   - Pass the changed-path set into the push command (`changedPaths?: string[]`) and filter in `rob.ts`, so the logic stays pure and testable.
   - If computing it fails, fall back to no inference for that push and emit a sanitized `recover` event. Never fall back to the whole tree.
2. Update the `(V2)` inference bullet in `app/CONTRACTS.md` to say "imports in files the entry changed since its `baseCommit`", and add a changelog line.
3. Tests, RED first:
   - an untouched trunk file's imports are not inferred;
   - a modified file's imports are inferred;
   - a diff failure produces no inference plus a `recover` event;
   - the existing `test/v4-real-hasher.test.ts` still infers `createOrder` from the UI's edited `src/ui/checkout.ts`.
4. Measure the push-path cost of the diff on the fixture and report it. The contract's ~300 ms guard applies.

## Deploy and verify live
- `npm test` in `app/control-plane` and `app/demo` (the demo 3 times): all green.
- Deploy `arb-control-plane` (`npx wrangler deploy` from `app/control-plane`). DO names stay `v2`, unless NOTES shows that a state-shape change requires a bump; if so, bump to `v2b` and record why.
- Live against `https://arb-control-plane.lautitomasalejo.workers.dev` with the admin key file:
  - main 2 times, failing-check once, multi once, all exit 0;
  - for main, record the UI entry's inferred symbols (they must no longer include `charge`), the `jev.judged` table, and the final stats.

## Safety net
- Known-good: tag `demo-stable-6`, Worker version `9f105998-1985-432d-af28-df1908c3d014`.
- If main or failing-check fails at the end of your time box:
  1. run `npx wrangler rollback 9f105998-1985-432d-af28-df1908c3d014`;
  2. verify that main passes;
  3. report `partial`.
- Do not use git to revert. Do not commit; the orchestrator commits.

## Final message
`## Result` (complete | partial | blocked), commands with observed results, the deployed version id, the live table, and the files changed. Also add `app/control-plane/NOTES.md` section "V8 inference scope" with the same data.
