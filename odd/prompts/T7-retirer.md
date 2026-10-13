First read `odd/prompts/_builder_head.md` completely and follow every rule in it. Then do the task below.

# Task T7: `app/retirer-spike`, prove fast-forward retirement from a Worker

## Allowed edit surfaces
app/retirer-spike/**

## Question
Artifacts has no server-side merge and no ref-update method on the binding. Can a Worker take an entry fork's commit C, a descendant of trunk main head T, and fast-forward `arb-trunk` main to C? That means fetching the needed objects from the fork and pushing them to trunk over git smart HTTP, using isomorphic-git with an in-memory fs inside the Worker.

## Requirements
- Setup:
  - Deploy throwaway Worker `arb-test-retirer` (Artifacts namespace `arb`).
  - Create test repos `arb-test-retirer-trunk` and its fork `arb-test-retirer-fork`, then push a commit to the fork.
- Implement `fastForward(env, { fromRepo, commit, toRepo, branch: "main" })`. It must:
  - verify that C descends from the trunk head (fast-forward only);
  - transfer the objects;
  - update the ref;
  - return the new head.
- Measure 5 runs: total ms plus phases (fetch / push). Report Worker memory/CPU concerns from `wrangler tail`. Repos are small fixtures.
- If isomorphic-git cannot work in a Worker, try these fallbacks:
  - (a) A Sandbox container running `git fetch && git push`, reusing the spike 5a image approach. Note that spike 5a found `docker push` through the Docker Desktop proxy breaks, so reuse its pre-pushed image if possible.
  - (b) "Pointer retirement": trunk is a DO pointer to {repo, commit}, materialized on demand by `fork()` of the retired entry's fork. Measure that fork's time.
  - Implement the fastest one that works and report all attempts.
- Export a reusable module `src/retire.ts` with `fastForward(...)` matching the `RetirerPort` in `odd/prompts/T6-control-plane.md`. The integration agent will copy it into control-plane.
