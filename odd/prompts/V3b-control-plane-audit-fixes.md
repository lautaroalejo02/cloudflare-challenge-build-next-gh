First read `odd/prompts/_builder_head.md` completely and follow every rule in it. Also read `odd/tasks/arb-v2.md`, `odd/prompts/V3-control-plane.md` (the original design) and the "(V2)" items in `app/CONTRACTS.md`. Another agent edits `app/mcp/` in parallel; do not touch it.

# Task V3b: Fix the audit findings in the V2 control plane (commit f70c0be)

## Allowed edit surfaces
app/control-plane/src/**
app/control-plane/test/**
app/control-plane/NOTES.md

Do NOT deploy and do NOT run live scenarios.

## Findings (RED test first for each, then GREEN)
1. **BLOCKER: `src/ports.ts` ~108, unbound fetch.** `realJev` passes `fetch: globalThis.fetch`; `jev.ts` calls `opts.fetch(...)`. In workerd that throws "Illegal invocation", so every judgment silently becomes null.
   - Fix: `fetch: (input, init) => globalThis.fetch(input, init)`.
   - Add a test that builds `realJev` with a stubbed `globalThis.fetch` that throws if `this !== globalThis` and `this !== undefined`, and asserts that the request goes through.
2. **Stale verdict loses the net change** (`rob.ts` ~1242-1248 with ~1311).
   - When a producer push arrives while `c.judging` already holds symbol `s` for an older commit, re-point the mark to the new commit and keep the ORIGINAL `oldBody` as the baseline. Do this even if `s` is unchanged relative to the previous push, and do it for every symbol in the existing mark.
   - Emit a new `judge` effect for the new commit covering every symbol whose net body (original baseline → current) differs.
   - The old verdict is dropped as stale; the new one decides.
   - Test: push A changes `s`, push B changes only an unrelated symbol, `judge.done(A)` arrives → a new judge for B covering `s`; a 0.95 verdict for B squashes.
3. **No `live(producer)` check in `judge.done`** (~1308-1311). If the producer is no longer live (retired, vetoed, squashed), drop the verdict, clear `judging`, emit `jev.unavailable` with reason `producer-not-live`, and let the normal cascade proceed. A squash must never re-fork from a retired producer's repo.
   - Tests: the producer retires mid-judgment; the producer is vetoed mid-judgment.
4. **Wrong `forkedExports` baseline** (~937). At `fork.done`, set `forkedExports` from the forked content, `{ ...producer.exports, ...cmd.exports }` (content wins, stub-only symbols kept). Run the existing drift re-diff against it, so an inferred entry forked mid-push is squashed once its inferred names are known.
   - Test: the producer pushes while the fork is in flight; inference later marks a name that differs → immediate `interface-changed` squash.
5. **False `deps.undeclared`** (~1082-1122). Consider only symbols the other entry actually changed: its `bodies[s]` or `exports[s]` differs from its own `forkedExports`/fork baseline. Simplest: track, per entry, the set of exported symbols whose `bodyHash` changed since its fork, from its own pushes. Never fire for trunk-inherited files.
   - Test: two trunk-forked entries importing the same untouched trunk file produce no event.
6. **Usage selection** (`effects.ts` ~277-293).
   - Only consumer files that import the symbol by name (`names` includes the symbol or `"*"`) count.
   - If the consumer has no files of its own that do so — none changed relative to its `baseCommit`, or no `headCommit` yet — return a null verdict with reason `no-usage`, without calling Jev.
   - Cap: at most 4 files and 6000 chars each.
   - Send usage only once in `state`; questions reference it by path, not by copy.
   - Tests: a consumer that never pushed → `no-usage` with no fetch call; a non-importing file is excluded; caps apply.
7. **Source store** (`ports.ts` ~80, `do.ts` ~70-76).
   - Store sources only for symbols currently consumed by at least one live consumer, each capped at 4000 chars.
   - Delete `src/<id>` on retire, veto and reset.
   - Log one sanitized `recover` event on a storage failure, instead of a silent catch.
8. **`jev.ts` body timeout** (~114-129). Keep the abort timer until `res.json()` resolves. Cancel non-ok bodies (`res.body?.cancel()`).
   - Test: a stalled body → null with reason `timeout`.
9. **Prototype names** (~1058-1061). Use `Object.hasOwn` for every `consumes`/`exports` membership check. Key the symbol→file map as `name` → set of files.
10. **Hot path** (~753-762). Do not allocate `initialState()` or loop all entries per `apply()`. Forward-fill once, at load or migration time.
    - Skip the Artifacts read entirely in `runJudge` when there is no API key: return `unavailable`/`no-key` immediately.

## Verification
- `npm test` in `app/control-plane`: counts. All existing tests stay green.
- `npx tsc --noEmit`: clean.
- `npx wrangler deploy --dry-run --outdir tmp/v3b-dry`: builds.
- Re-run the bench (`app/control-plane/bench/`, see `RESULTS.md` for the command) at 100k entries. Report the per-event cost against the recorded 2.7 µs.
- NOTES.md: a "V3b audit fixes" table with finding → fix → test name.
