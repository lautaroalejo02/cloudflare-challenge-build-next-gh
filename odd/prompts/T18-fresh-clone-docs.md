First read `odd/prompts/_builder_head.md` completely and follow every rule in it. Then do the task below. Do not deploy anything, and do not run live scenarios.

# Task T18: Fresh-clone reproducibility check and docs sync

## Allowed edit surfaces
README.md
docs/**

## Part A: fresh clone, as a judge would do it
1. Clone the public repo into a scratch dir inside the repo's ignored `tmp/` folder:
   `git clone --branch feat/agent-reorder-buffer https://github.com/lautaroalejo02/cloudflare-challenge-build-next-gh.git tmp/fresh-clone`
   Cloning into `tmp/` does not change this repo's git state, and `tmp/` is gitignored.
2. Follow README.md's run instructions literally, inside `tmp/fresh-clone`, for everything that does not need Cloudflare credentials:
   - `npm ci` / `npm install` per package;
   - every package's `npm test`;
   - the local mock demo, if the README documents one (e.g. `npm run mock` + `npm run demo -- --base http://127.0.0.1:<port>`);
   - opening `app/dashboard/mock.html`. A headless screenshot is optional.
3. Record every step that fails, is ambiguous, or is missing: wrong path, missing script, missing prerequisite, Windows vs Unix difference, wrong Node flag. Fix them in README.md / docs (NOT in app code). If a fix needs app code, list it under "Needs code change" in your final message instead.

## Part B: docs sync with T17
Read `app/control-plane/NOTES.md` section "Trunk race fix (T17)" and the `app/CONTRACTS.md` changelog. Retirement is now one atomic attempt inside ArbTrunk (head read → fast-forward/splice/overlap → candidate build → check → move main, with bounded rebuild), with `retire.retry` / `retire.failed` events. The old two-phase `retire.planned`/`retire.commit` protocol was removed. Update README.md and `docs/architecture.md` wherever they describe the old protocol, and add the new events. Also mention the `--scenario multi` demo in the run instructions and demo script if missing.

## Verification
- In the final message:
  - the exact command sequence you ran in the fresh clone, with each observed result;
  - the doc fixes made;
  - the "Needs code change" list.
- Grep the docs for `retire.planned` / `retire.commit`. Each remaining mention must be explicitly historical.
- Remove `tmp/fresh-clone` at the end.
