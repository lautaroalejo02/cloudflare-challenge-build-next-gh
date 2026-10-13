Read `odd/prompts/_builder_head.md` and follow its rules, except: you may run `git diff`/`git status` but do not commit (the orchestrator commits). Also read `odd/tasks/arb-v2.md` and the "(V2)" items in `app/CONTRACTS.md`. Other agents edit `app/hasher/`, `app/mcp/`, `app/control-plane/` in parallel; do not touch them.

# Task V5: Dashboard — render V2 dependency inference and Jev judgments

## Allowed edit surfaces
app/dashboard/**

You built the current redesign (`dfc05ea`). Keep its visual language and its hierarchy, which puts "what is blocked and why" first. Plain HTML/CSS/JS, no build step, no CDN.

## Render (from the V2 contract)
1. **Inferred dependencies.**
   - Entries with `consumesInferred`: consumed-symbol tags marked as inferred (e.g. a subtle "inferred" badge).
   - `deps.inferred`: a brief highlight on the new tags.
   - `deps.undeclared`: a warning on the consumer naming the other entry and the symbols.
2. **Jev judging.**
   - While `entry.judging` is non-empty, the consumer shows a "judging" state on the affected symbols.
   - `jev.judged`:
     - `clear` → a quiet tick;
     - `warn` → a visible but non-blocking warning with the probability;
     - `squash` → shown through the squash with reason `behavior-changed`.
   - `jev.unavailable` → a dim note ("semantic check unavailable"), never alarming.
3. **Squash diagnosis for `behavior-changed`.** Use the same 3-line style as other squashes:
   - the symbol;
   - "signature unchanged · behavior changed";
   - "Jev p=0.86" (from `diagnosis.judgment.probability`, two decimals).
4. **Stats.** Add `judgments`, `semanticSquashes` and `inferredDeps` to the stats area at secondary priority. Handle them being absent (an old Worker) by showing nothing; do not crash.
5. **Mock replay (`mock.js`).** Extend the replay with a V2 beat after the existing body-only early cutoff:
   - the UI consumer registered without `consumes` → `deps.inferred` for `createOrder`;
   - the API pushes a body change → `hash.unchanged`, the UI shows judging;
   - `jev.judged` clear for the tests lane;
   - `jev.judged` squash (p=0.86) for the UI;
   - squash `behavior-changed`, refork, then the flow continues to the existing breaking-change beat and retirement.

   Keep all existing beats.

## Tests
- Extend the `node --test` suites with: reducer/state handling for each V2 event and field, absent V2 stats, and the `behavior-changed` diagnosis text.
- `npm test` in `app/dashboard` must stay green.

## Verification
- `npm test`: counts.
- Open `mock.html`, run replay, and capture screenshots at 1280x720 and 1920x1080 of: the judging state, the `behavior-changed` squash, and the inferred tags. Save them in `app/dashboard/screenshots/v2-*.png`.
- Final message: `## Result` (complete | partial | blocked), commands with observed results, files changed.
