First read `odd/prompts/_builder_head.md` completely and follow every rule in it. Then do the task below. Another agent edits `README.md` and `docs/**` in parallel; do not touch those.

# Task T9c: Fix demo defects found by the orchestrator's live run, redeploy, capture the live dashboard

## Allowed edit surfaces
app/demo/**
app/dashboard/**
app/control-plane/**

Change `app/control-plane` only if a defect below is caused there, and add a test for the change.

## Evidence (orchestrator's live run, log in `odd/logs/parent-e2e.txt`)
`npm run demo -- --base https://arb-control-plane.lautitomasalejo.workers.dev` exited 0, but showed these defects:
1. **Process hang.**
   - The timeline completes at +40.5 s ("demo complete"), but the process only exits after ~311 s of wall time, i.e. at the 5-minute scenario timeout.
   - Something keeps the event loop alive: an interval, a timer, an HTTP keep-alive agent, or a child process.
   - Fix: on completion, clear everything and exit immediately with the right code.
2. **Tests agent contributes nothing in generation 1.**
   - After the squash, the tests agent logs `writing v2 feature test` and then `nothing to commit ... already on base`. It retires with head `6ea008d9`, which equals the API entry's head, so its feature test never reached trunk from its own commit.
   - Likely cause: clone dirs are `app/demo/tmp/<entryId>-g<generation>`. Entry ids restart at e1 after `/api/reset`, so a new run reuses stale clones from earlier runs. A second suspect is fork-name collision handling in the control plane (`-xN` suffixes / repo aliasing after reset) pointing at an old repo.
   - Find the real cause with evidence, then fix it:
     - make clone dirs unique per run (e.g. a run id) and clean stale dirs at scenario start;
     - if the control plane can alias to a stale repo, fix it there too, with a test.
3. **Misleading dashboard stat.**
   - The "squash after push" stat is synthetic in the mock (~1.2 s spacing). Live, squash and push events share a timestamp, so it reads ~0 ms.
   - Replace it with an honest server-side metric computed from real event timestamps, e.g. "re-fork ready in X s" (squash event → refork event), or remove it.
   - Keep the mock consistent.

## Then
4. Redeploy `arb-control-plane` (from `app/control-plane`: `npx wrangler deploy`) so the polished dashboard in `app/dashboard` is live.
5. Run the LIVE main scenario and `--scenario failing-check`. Acceptance:
   - both exit 0, and the process exits within 10 s of completion;
   - in the main scenario, the tests entry's final head differs from the API entry's head;
   - a fresh clone of `arb-trunk` main contains `tests/create-order.feature.test.ts` added by the tests agent's own commit (show it with `git log --format='%h %s' -- tests/create-order.feature.test.ts`).
   Paste both timelines (trimmed) and the git log line into `app/demo/NOTES.md` under "Live run (T9c)".
6. While the main scenario runs, capture the live dashboard with a headless browser at the SQUASH moment and at the end: `npx playwright screenshot --channel msedge --viewport-size=1920,1080 https://arb-control-plane.lautitomasalejo.workers.dev/ ...`. Use a script that waits for the right moment, e.g. playwright with a `waitForSelector` on the squash element. Save them as `app/dashboard/screenshots/live-squash.png` and `live-final.png`.
7. Re-run the test suites of every package you touched, and report the results.
