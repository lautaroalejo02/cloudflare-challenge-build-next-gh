First read `odd/prompts/_builder_head.md` completely and follow every rule in it. Then do the task below. You are the ONLY agent allowed to change `app/control-plane` in this phase. Two other agents work in parallel, on `app/dashboard/**` and on `README.md` + `docs/**`; do not touch those.

# Task T8: Integration, from all real parts to a live end-to-end scenario

## Allowed edit surfaces
app/control-plane/**
app/demo/**
app/hasher/**
app/checker/**
app/CONTRACTS.md

Edit `app/demo`, `app/hasher` and `app/checker` only for fixes the integration needs. Edit `app/CONTRACTS.md` only to document real behavior, and add a "Changelog" line for each change.

## Context
All packages exist and are individually verified. Read each package's `NOTES.md`:
- `app/control-plane`: deployed as `arb-control-plane`. It uses STUB hasher, checker and retirer ports.
- `app/hasher`: tree-sitter hashing, verified in a Worker. NOTES.md explains lazy init with a `CompiledWasm` rule.
- `app/checker`: `runChecks` in a Dynamic Worker (needs a `worker_loaders` binding).
- `app/retirer-spike/src/retire.ts`: isomorphic-git fast-forward from a Worker (needs `nodejs_compat`), ~0.9 s.
- `app/demo`: scripted agents plus `npm run demo -- --base <url>`. It passes against its local mock.
- Read the "Decision: retirement when fast-forward is impossible" section in `odd/tasks/agent-reorder-buffer.md`. You must implement it.

## Requirements
1. Replace the stub ports in `app/control-plane` with the real implementations:
   - `HasherPort` → `app/hasher` (relative import).
   - `CheckerPort` → `app/checker` (relative import, LOADER binding).
   - `RetirerPort` → a copy/adaptation of `app/retirer-spike/src/retire.ts` placed inside `app/control-plane/src/`, wrapped to match the port.
   - Update `wrangler.toml` accordingly: `CompiledWasm` rule, `worker_loaders`, `nodejs_compat`.
2. Retirement, per the Decision section:
   - Fast-forward when the trunk head is an ancestor of the entry head.
   - Otherwise do the path-disjoint splice: P = paths changed by the entry vs its baseCommit; Q = paths changed on trunk since that base.
     - If P ∩ Q = ∅: build the spliced commit (trunk tree + P overlaid from the entry head) with isomorphic-git in memory, and push it to trunk on a candidate ref (e.g. `refs/heads/arb-candidate`). Run checks on that candidate commit. Only if they pass, move `main` to it (fast-forward from the trunk head).
     - If P ∩ Q ≠ ∅: squash with reason `trunk-overlap` (add it to the `Diagnosis.reason` union in CONTRACTS with a changelog line).
   - Emit events that make the path visible: e.g. `retired` with `data.mode = "fast-forward" | "splice"`.
   - Unit-test the splice decision logic (pure function: P, Q → splice | squash) in `test/`.
3. Checks at retirement run on the commit that would become trunk: the entry head for fast-forward, the candidate for splice.
4. Deploy `arb-control-plane`. Then run the LIVE scenario from `app/demo`: `npm run demo -- --base https://arb-control-plane.lautitomasalejo.workers.dev`. Iterate fixes until it exits 0 with:
   - all three entries retired,
   - at least 1 early cutoff,
   - exactly the expected squashes,
   - `arb-trunk` main containing all three agents' work (verify with `git clone` of arb-trunk and grep).
   Then run `--scenario failing-check` until it exits 0.
5. Measure and record, in `app/control-plane/NOTES.md` under "Live E2E results": total scenario wall time, time from producer push to squash event, retirement time per entry and mode (fast-forward/splice), and check durations. Paste the scenario timeline output (trim it to ~60 lines).
6. Re-run all package test suites you touched and report them.

If push events (namespace-wide subscription) are slow or missing, the alarm-poll fallback must still make the scenario pass. Report which path detected each push, if observable.
