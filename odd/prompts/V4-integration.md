First read `odd/prompts/_builder_head.md` completely and follow every rule in it. Also read:
- `odd/tasks/arb-v2.md`;
- every "(V2)" item in `app/CONTRACTS.md`;
- `app/control-plane/NOTES.md`: the sections "V2 (inference + Jev)", "V3b audit fixes", and the older notes on alarmed DOs pinned to old deployments.

You are the only agent deploying and running live scenarios now.

# Task V4: Integrate V2 end to end, add the behavior-change demo beat, deploy, verify live

## Allowed edit surfaces
app/control-plane/**
app/demo/**
app/CONTRACTS.md (changelog lines only)

## Steps
1. **Real wiring check.** Confirm that the control plane's push handling uses the real hasher's `extractImports` and `SymbolSignature.bodyHash/source/file` (hasher commits `f01087f` and `7b533a6`). Add one test that runs the real hasher on `app/demo/fixture/` files and feeds the control plane's push path, if it is not already covered. It must assert that `src/ui/checkout.ts` infers `createOrder` from `src/api/order.ts`.
2. **Demo beat: a behavior change** (`app/demo/src/agents/*`, `fixture/`, `scenario.ts`).
   - Inference: in the main scenario, the UI agent registers WITHOUT `consumes`. The tests agent keeps its declared `consumes`, so the timeline shows both styles.
   - Beat order: stub/prediction, then the body-only refactor (early cutoff, must stay a `clear`), then the new beat, then the existing breaking signature change, then retirement.
   - The new beat: the API agent pushes a body-only change that clearly changes observable behavior with the same signature. Example: `createOrder` returns its total in cents instead of currency units, or applies tax twice. Pick something Jev will clearly judge as behavior-changing and the earlier refactor clearly as not.
   - Squash handling: if a consumer is squashed with `behavior-changed`, its redo must adapt to the new behavior, so the final tests pass. If Jev is unavailable or clears, the scenario must still complete. Make the agents' redo work correct for both outcomes.
   - Timeline: print `jev.judged` events with their probability and verdict, and `deps.inferred` events.
   - The scenario's final line still requires all entries retired.
   - Add the V2 stats (`judgments`, `semanticSquashes`, `inferredDeps`) to the final stats print.
3. **Mock server** (`app/demo/src/mock-server.ts`): accept registration without `consumes` (treat it as none; no inference in the mock) and default the new Entry fields, so `npm test` in `app/demo` stays green. Run it 3 times.
4. **Ops.**
   - Bump the DO instance names, e.g. `router-t19` → `router-v2`, `trunk-t19` → `trunk-v2`, component prefix `t19:` → `v2:`. Alarmed DOs stay pinned to old code.
   - If the file `app/control-plane/.secret-typesafe-key` exists and is non-empty, set the Worker secret by piping the file into `npx wrangler secret put TYPESAFE_API_KEY`, then confirm with `npx wrangler secret list` (names only). If it does not exist, deploy without it and record that Jev runs as "unavailable".
   - Never print, echo, cat or log the key value. Never put it in a command line argument.
5. **Deploy** `arb-control-plane` (from `app/control-plane`, `npx wrangler deploy`). Record the version id.
6. **Live verification** against `https://arb-control-plane.lautitomasalejo.workers.dev`, admin key via the demo's default key file:
   - main 3 times; for each run, record exit code, stats, every `jev.judged` (symbol, probability, verdict), and whether a `behavior-changed` squash happened;
   - failing-check once;
   - multi once.

   All must exit 0. If Jev is configured, the body-only refactor must judge `clear` and the behavior change `squash` in at least 2 of 3 main runs. If Jev disagrees, adjust the demo change to be less ambiguous, not the thresholds.
7. **Proof of auth and secrets:**
   - `curl -X POST .../api/reset` without the key → 403;
   - `GET /api/events` contains no `art_v2_` and no `Bearer` (grep the JSON).

## Safety net
- Known-good: tag `demo-stable-5`, Worker version `b3e47042-6c08-467a-b947-3350a0b7ce40`.
- If, at the end of your time box, main and failing-check do not both pass:
  1. roll back with `npx wrangler rollback b3e47042-6c08-467a-b947-3350a0b7ce40`;
  2. verify that main passes;
  3. report `partial` with exact blockers.

  Do not use git to revert.

## Verification (final message)
- Test counts for `app/control-plane` and `app/demo` (3 runs).
- Deployed version id.
- The live run table.
- The auth and secret-grep results.
- NOTES: `app/control-plane/NOTES.md` section "V2 integration (V4)" with the same data.
