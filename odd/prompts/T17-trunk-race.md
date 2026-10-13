First read `odd/prompts/_builder_head.md` completely and follow every rule in it. Then do the task below. You are the only agent changing code and running live scenarios now.

# Task T17: Fix the cross-component retirement race on the shared trunk

## Allowed edit surfaces
app/control-plane/**
app/demo/**
app/CONTRACTS.md
app/dashboard/NOTES.md

Edit `app/demo/**` only if a scenario needs adjusting. Edit `app/CONTRACTS.md` only for a changelog line. Edit `app/dashboard/NOTES.md` only to remove the delay workaround once it is unnecessary.

## Defect (found while recording footage; see `app/dashboard/NOTES.md` and `odd/logs/T16.out`)
In the sharded control plane (T14: ArbRouter, ArbTrunk, ReorderBuffer per component), the splice path has a stale-candidate race:
1. `retire()` builds the splice candidate on the trunk head it read.
2. The candidate is checked.
3. Then `moveBranch` moves main.

If another component lands on trunk between steps 1 and 3, `moveBranch` is rejected as non-fast-forward. Worse, the component is wedged forever: `_internal.retiring` is never cleared.
- It reproduces in `npm run demo -- --scenario multi` when both chains retire close together.
- The recording agent avoided it with `--delay-ready e5:30000`. That is a workaround, not a fix.

## Requirements
1. **Make retirement on the shared trunk atomic per attempt inside ArbTrunk.**
   - Under ArbTrunk's single queue, do: read the current head → decide fast-forward vs splice (path-disjoint rule from the Decision section of `odd/tasks/agent-reorder-buffer.md`) → build the candidate → run checks on it → move main.
   - If the move is still rejected, or trunk moved: rebuild from the new head and re-check, with bounded retries (e.g. 3).
   - If paths now overlap: squash with reason `trunk-overlap`, per the existing rule.
2. **Never wedge.**
   - Every failure path clears `retiring` and emits a visible event, e.g. `retire.retry` or `retire.failed` with a reason.
   - The component's next cascade can then try again.
   - Add regression tests in `test/` (pure logic where possible) covering: concurrent retirements from two components, rejection then rebuild, and retiring-flag cleanup on every error path.
3. **Keep the ordering guarantees:**
   - in-order retirement within a component;
   - no head-of-line blocking across components;
   - checks always run on the exact commit that becomes trunk.

## Verification
- `npm test` in `app/control-plane`, `app/demo` and `app/dashboard` is green.
- Deploy `arb-control-plane`.
- Live, against `https://arb-control-plane.lautitomasalejo.workers.dev`:
  - run `--scenario multi` 5 times WITHOUT any delay flag. All 5 must exit 0, and you report each run's stats and whether any `retire.retry` occurred;
  - run main and `--scenario failing-check` once each. Both must exit 0.
- Record the results in `app/control-plane/NOTES.md` under "Trunk race fix (T17)".

## Safety net
- Last known-good: git tag `demo-stable-2`, deployed Worker version `8bfc389a` (find the full id with `npx wrangler deployments list`).
- If you cannot make main and failing-check pass by the end of your time box, roll back with `npx wrangler rollback <full 8bfc389a id>`, verify main passes, and report `partial`. Do not use git to revert.
