First read `odd/prompts/_builder_head.md` completely and follow every rule in it. Then do the task below. You are the only agent changing code in this phase.

# Task T14: Make the scale claim real with index maps and one Durable Object per connected component

## Allowed edit surfaces
app/control-plane/**
app/dashboard/**
app/demo/**
app/CONTRACTS.md
README.md
docs/**

## Evidence
Read `app/control-plane/bench/RESULTS.md`. In the pure state machine `src/rob.ts`, per-event cost grows with N in a single buffer:
- `head()` filters and sorts all entries on every `apply()`, via `cascade()`.
- `squashTree` and the push loop rescan all entries for each squashed node.
- Lookups (by id, by repo, pending) are linear.
- Per-component buffers stay flat. The deployed control plane routes everything to ONE DO (see `src/index.ts`, the `idFromName(...)` call).

## Requirements
1. **Index maps in `rob.ts`, test-first.**
   - Maintain indexes: id→entry, repo→entry, producerId→consumers, pending forks, and a head cursor (the lowest live seq).
   - Keep the state JSON-serializable: rebuild indexes on load, or store them as plain objects.
   - Keep all existing tests green, and add tests that the indexes stay consistent across create, fork, squash, re-fork, retire, veto and reset.
   - Re-run `bench/run.ts` and append before/after numbers to `bench/RESULTS.md`.
2. **One ReorderBuffer DO per connected component.**
   - Component key = the root producer's entry id. An entry with no producer starts a new component; consumers join their producer's component.
   - The Worker routes `/api/entries*` to the right DO. Store an entry→component mapping, e.g. encode the component in the entry id (`<component>.e<seq>`), or keep a tiny routing table in a separate "router" DO or KV.
   - Push events route by repo name. Encode the component in the fork name, or look it up in the routing table.
   - Retirement onto the shared trunk must stay serialized across components. Use a dedicated "trunk" DO (single-threaded) that owns fast-forward and splice, and that the component DOs call. Document why: trunk is the single shared resource.
   - `/api/state` and `/api/ws` aggregate across components. The dashboard must keep working: group by component if that is cheap.
   - Update CONTRACTS with a changelog line.
3. **Demo.**
   - The existing main and failing-check scenarios must still pass live, with unchanged stats expectations.
   - Add `npm run demo -- --scenario multi` that runs two independent producer/consumer chains concurrently: e.g. "orders" (api/ui/tests) and "payments" (api/ui). Show that a squash in one component never touches the other, and that both retire onto trunk.
4. **Deploy and verify live.**
   - Bump the DO namespace name if needed. NOTES explain the "alarmed DO pinned to old deployment" issue.
   - Run main, failing-check and multi against `https://arb-control-plane.lautitomasalejo.workers.dev`. All must exit 0.
   - Record the stats in `app/control-plane/NOTES.md` under "Sharding (T14)".
5. **Docs.** Update the README "Why it scales" section and `docs/architecture.md` to say what is now implemented, citing the new bench numbers. Never claim beyond the evidence.

## Verification
- All package test suites are green: control-plane, demo, dashboard. Run `npm test` in `app/demo` 3 times.
- Report the 3 live scenario results with their stats.

## Safety net
- Last known-good state: git tag `demo-stable-1`, and deployed control-plane version `a1c784f2-456f-4920-a790-2de3277d7e3b`.
- If, at the end of your time box, the main and failing-check live scenarios do not both pass with your changes:
  1. Roll the Worker back with `npx wrangler rollback a1c784f2-456f-4920-a790-2de3277d7e3b` (from `app/control-plane`).
  2. Confirm the main scenario passes again live.
  3. Report `partial` with exact blockers. Leave your source changes in place for the orchestrator to review; do not use git to revert.
- The demo working end to end matters more than sharding.
