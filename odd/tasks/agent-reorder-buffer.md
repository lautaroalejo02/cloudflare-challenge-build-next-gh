# Feature: Agent Reorder Buffer (ARB)

Locator: `odd/tasks/agent-reorder-buffer.md` · Engram mirror: `odd/agent-reorder-buffer/tasks` · Branch: `feat/agent-reorder-buffer`

## Objective
Build the hackathon entry for Cloudflare "Build the next GitHub" (deadline 2026-10-14): Idea 3 from `research/top10.md`. Coding agents never wait on each other and never merge text: each change is a buffer entry backed by its own Artifacts fork. Consumers fork the producer's unfinished fork. A Durable Object squashes consumers only when a consumed interface hash changes, and retires entries onto trunk in order after checks pass.

## Problem / why
"UI waits for the API PR" is the main serialization point between parallel agents, and textual merge conflicts plus human review do not scale to 100K agents. The ARB turns integration into a dispatch-time protocol where the human decides only speculation depth and vetoes.

## Scope
- In: control-plane Worker + DO, push-event-driven squash, interface hashing in a Worker, Dynamic-Worker checks at retirement, fast-forward retirement onto `arb-trunk`, scripted three-agent demo (API/UI/Tests), live pipeline dashboard, README with run instructions.
- Out (stretch only): stub value prediction counter, Grace Period hand-off, disjoint-path splice retirement, LLM-driven agents.

## Constraints
- Must use Cloudflare Workers + Artifacts (hard requirement).
- Contracts: `app/CONTRACTS.md` is the single source of truth for parallel work.
- Platform facts and caveats: `spikes/SPIKES.md` (Wrangler >= 4.149.0, git auth via token in URL, timers freeze in sync CPU, etc.).
- Commits: Conventional Commits, no AI attribution lines (user rule).
- Owner (user) asleep overnight 2026-10-13: no questions; decisions are documented here.

## Acceptance criteria
1. `npm run demo` in `app/demo` drives the organizers' scenario end to end against the deployed control plane. The scenario: the API agent changes `createOrder`'s signature mid-run, the UI and Tests entries are squashed and re-forked automatically, and all three retire onto `arb-trunk` main in order.
2. A body-only producer push causes no squash (early cutoff), visible in stats.
3. Checks run in a Dynamic Worker on each entry's head commit before retirement; a failing test blocks retirement.
4. Dashboard shows lanes, forwarded hashes, SQUASH, checks and retirements live over WebSocket.
5. README explains the mechanism and the run steps, and states which parts are mocked (agent intelligence is scripted).

## Delivery strategy
`ask-on-risk` (default). Forecast is well over 400 changed lines across packages. Chain strategy is pending the user's choice in the morning; until then, work-unit commits stay on this branch. No push, PR or merge without the user.

## Tasks
Route legend: D = delegated (Devin SWE-2 writer, own directory), I = inline (orchestrator).

- [x] T0 (I) Research council + 8 platform spikes. Commit `f62b940`.
- [x] T1 (I) Write `app/CONTRACTS.md` and this document. Commit `dfe4704`.
- [x] T2 (D) `app/hasher`: tree-sitter TS exported-interface hash for Workers, with tests (reuses spike 4 rules + spike 6 wasm). Commit `dace7ad`. Parent spot check: `npm test` ALL PASS (24 checks); Worker hashes byte-identical to Node.
- [x] T3 (D) `app/checker`: run commit tests in a Dynamic Worker with TS stripping, with a deployed proof. Commit `9457e26`.
  - Parent spot check: `npm test` gave 10/10 pass. Deployed `arb-test-checker` on failing commit `7097b6f9…` gave passed 2 / failed 2 with real errors, in 219 ms.
  - Note: full 40-char SHAs required.
  - RDD: assess = high/unassessable (untracked files from parallel writers), so the review is due and consent is pending the user.
- [x] T4 (D) `app/demo`: fixture app + scripted agents + scenario runner + mock control plane for its own tests. Commit `cab15e2`.
  - Parent spot check: `npm test` gave 5/5 pass.
  - Finding: after an early-cutoff producer push, a consumer fork no longer contains the producer's final head, so fast-forward retirement is impossible. The mock uses a `-X theirs` merge, which is NOT acceptable for the real system.

## Decision: retirement when fast-forward is impossible (2026-10-13, orchestrator, owner asleep)
Retire by fast-forward when the trunk head is an ancestor of the entry head. Otherwise do a **path-disjoint splice**:
- Let P = the paths the entry changed (entry head vs its `baseCommit`).
- Let Q = the paths trunk changed since the entry's base.
- If P ∩ Q = ∅, create a new trunk commit: trunk tree with P overlaid from the entry head, parents = [trunk head], message referencing the entry commit.
- If P ∩ Q ≠ ∅, squash the entry (reason `trunk-overlap`) so its agent re-applies its change on a fresh fork.

There is never a textual merge. Rationale: changes on disjoint paths commute (patch theory, Darcs), so the splice is order-independent and safe. Checks still run on the spliced tree before trunk moves. T8 implements this in the retirer.
- [x] T5 (D) `app/dashboard`: static pipeline UI with mock event replay. Commit `26abc52`.
  - Parent spot check: `node --test` gave 14/14. The squash screenshot was reviewed visually.
  - Polish for T9: the producer→consumer arrows render as stray diagonals between cards.
- [x] T6 (D) `app/control-plane`: Worker + ReorderBuffer DO + queue consumer + API; pure, unit-tested ROB state machine (`src/rob.ts`). Commit `af4b1ec`. Parent spot check: `npm test` 11/11; live `/api/state` 200 and dashboard served at `/`. Writer's live smoke run: squash ~8 s after push; early cutoff and veto observed. Uses a namespace-wide push subscription `arb-ns-push-sub`.
- [x] T7 (D) `app/retirer-spike`: prove fast-forward retirement from a fork to `arb-trunk` main from a Worker (isomorphic-git), with timings. Commit `0362bdd`. Result: FF via isomorphic-git in a Worker (`nodejs_compat`), ~0.9 s median, 17-45 ms CPU; a non-descendant gets 409.
- [x] T8 (D) Integration: wire hasher, checker and retirer into control-plane; implement the path-disjoint splice; deploy; run the scenario end to end; fix. Commits `bad849c` (control plane, CONTRACTS changelog) and `635d372` (demo failing-check fix).
  - Writer evidence: live main scenario ~38 s; failing-check exercised a real failed check, then the fix, then a splice retirement (`arb: splice 7c42bc81 onto f4a406a3`). Timings: push to squash ~1.7 s, refork 2.3-4.5 s, checks 90-187 ms, fast-forward ~510 ms, splice 1085 ms.
  - Parent spot check: `npm test` (control-plane) gave 26/26. The parent ran the live main scenario: exit 0, 3/3 retired in order, squashes 2, early cutoffs 2 (log `odd/logs/parent-e2e.txt`, gitignored).
  - Defects found by the parent: (a) the process hangs until the 5-min timeout after completion (311 s wall vs 40.5 s timeline); (b) in gen 1 the tests agent reported 'nothing to commit - already on base' and retired with head == API head, likely because stale clone dirs are reused across runs. These were sent to T9c.
- [ ] T9 (D) Demo hardening, split into parallel writers on disjoint surfaces:
  - [x] T9c: fix the hang, the stale clones and the honest squash-latency stat; redeploy; capture live dashboard screenshots. Commits `47fc190`, `3c2a186`.
    - Root cause: `arb-trunk` survives `/api/reset`, so stale retired files leaked into new seeds. Clone dirs are now run-unique, and the buffer ignores pushes during a pending re-fork (regression test added).
    - Parent spot check: re-ran the live main scenario; exit 0, process exits ~4 s after completion (66 s wall vs 61.7 s timeline), e3 head `a779ae21` != e1 head `8e557ad1`. The live squash screenshot was reviewed.
  - [x] T9d: replace README/docs TBDs with live evidence. Commit `5ddda57`. 0 TBDs remain.
  - [x] T9a: dashboard polish + real-event alignment. Commit `e77db98`. Parent spot check: `node --test` gave 24/24; the 1920x1080 squash screenshot was reviewed and the connectors are clean.
    - OPEN: the "squash after push" stat is synthetic in the mock (~1.2 s spacing). Live, squash and push share a timestamp, so the stat would read ~0 ms. Before the video, fix it (measure from the git push time) or hide it.
  - [x] T9b: README, architecture doc and video script. Commit `3967610`. Parent structural readback done. Live E2E numbers are TBD until T8.
- [x] T11 (D) Value prediction: declared stubs, hit/miss counter. Commit `0379ee9` (resumed after the rate limit via `T11b-resume.md`).
  - Writer: control-plane 33/33, demo 8/8, dashboard 27/27; 4 live runs exit 0 with 2 hits / 1 miss.
  - Parent: my live run hit a transient Artifacts HTTP 500 on clone (exit 1). Prediction stats were still correct (2/1).
  - Parent fix, inline: `60faf3a` retries transient git failures and redacts tokens in error output (the old error printed a live token). TDD: RED on missing exports, then GREEN. The next live run exited 0 with no tokens in the log.
  - Found regressions, sent to T15: earlyCutoffs dropped to 0 in the live main scenario; `failing-check` mock test is flaky (~1/4).
- [x] T12 (D) Scale benchmark of pure `rob.ts` at N = 1K/10K/100K, one buffer vs per-component buffers. Commit `1ab5382` (finished by a Claude subagent after the SWE-2 rate limit).
  - Single buffer: median per event 29.6 µs / 394 µs / 16.2 ms at 1k / 10k / 100k (super-linear; linear scans in `head()`, `squashTree`, lookups).
  - Sharded: per-event work flat (<20 µs).
  - Containment: 0 squashes outside transitive dependents across 3,803 pushes.
  - Parent spot check: N=1000 run reproduced (head() 23.6 µs single vs 1.3 µs sharded).
- [x] T14 (D) Index maps + head cursor in `rob.ts`; ArbRouter DO + one ReorderBuffer DO per component + ArbTrunk DO serializing retirement. Commits `3c41784`, `153ad02`, `70a9147`.
  - Bench median per event, after: 2.1 / 2.4 / 2.7 µs at 1k / 10k / 100k (before: 29.6 µs / 394 µs / 16.2 ms).
  - Writer: live main / failing-check / multi all exit 0; Worker `8bfc389a`.
  - Parent spot check: control-plane `npm test` 41/41; live main exit 0 (prediction 2/1, early cutoffs 2, squashes 3, retired 3); live multi exit 0 (retired 5, squashes stayed inside their components).
  - Tagged `demo-stable-2`.
- [x] T13 (D) Docs refresh with T11/T12 evidence. Commit `4f0042f`. Parent structural readback: 3 embedded screenshots exist; the scale section is present and honestly states that ONE DO is deployed today.
- [x] T15 (D) Restore the early-cutoff scene; fix the flaky failing-check test. Commit `e8e85b8`.
  - Root cause of the flake: a stale `failed` verdict was read before the re-check ran on the fix commit.
  - Parent spot check: `npm test` 3/3 runs 12/12; live main exit 0 with prediction 2/1, early cutoffs 2, squashes 3, retired 3.
  - Tagged `demo-stable-1`; known-good Worker version `a1c784f2-456f-4920-a790-2de3277d7e3b`.
- [x] T16 (D) Record live dashboard footage. Commit `9d2a236`.
  - Takes: main, multi, multi-720, failing-check. The `.webm` files are LOCAL ONLY (gitignored, 16-30 MB each) in `app/dashboard/recordings/`; timelines are committed.
  - Parent check: ffprobe main.webm = 86.9 s; no tokens in the timelines.
  - Found defect: cross-component splice-candidate race on the shared trunk can wedge a component (`retiring` never cleared). The recording avoided it with `--delay-ready e5:30000` (workaround).
- [x] T17 (D) Trunk retirement is atomic per attempt inside ArbTrunk, with bounded rebuild, never wedges, and emits retire.retry/retire.failed. Commit `c476588`; Worker `4e0fdc50`.
  - Writer: control-plane 54/54; 5/5 live multi runs without a delay, all exit 0.
  - Parent spot check: control-plane `npm test` 54/54; 2/2 live multi runs without a delay, exit 0 (retired 5, squashes 4).
  - Parent found a deploy-blocking issue: footage over 25 MiB inside the assets dir breaks `wrangler deploy` (confirmed by dry-run). Fixed with `app/dashboard/.assetsignore` (commit `ae8d957`): the dry-run fails without it and passes with it.
  - Tagged `demo-stable-3`.
- [x] T18 (D) Fresh clone from GitHub, following the README literally; docs sync with T17. Commit `01d06d7`.
  - The fresh clone works for tests and the mock demo.
  - Fixed in docs: stale test counts, scenario flags, Git Bash note.
  - Needs code: the mock lacks `GET /api/events`, so `--scenario multi` against the mock exits 1 (docs scope multi to the deployed plane). Playwright browsers need `npx playwright install` on a fresh machine.
- [x] R1 (D, read-only) Independent Opus review. 0 critical, 4 high, 5 medium, 3 low; `npm test` 54/54.
  - Core verified sound: checks always run on the exact landing commit; P/Q use the right base; never a textual merge; in-order within a component.
  - High:
    - unauthenticated destructive and token endpoints;
    - transient infra failures treated as permanent check failures;
    - a failed effect wedges the component;
    - a lost squash when the producer pushes during the consumer's in-flight fork (reproduced).
  - Medium:
    - a veto during retire is overridden (reproduced);
    - a push during retire desyncs trunk and buffer;
    - splice disjointness misses file/dir conflicts (reproduced);
    - the one-shot re-fork token;
    - out-of-order push handling;
    - ops: alarm pinning, `-xN` collisions.
- [x] T19 (D) Fix the R1 findings with regression tests; admin-key auth; deploy. Commits `1b11810`, `f7dee93`, `eb37f82`; Worker `9a6c1738`; tag `demo-stable-4`.
  - The SWE-2 max run hit the free-model rate limit again (reset 15:01 UTC) after partial edits. A Claude Opus subagent finished it: all 11 findings fixed, and the mock gained `/api/events`.
  - Writer: control-plane 92/92, checker 17/17, dashboard 31/31, demo 16/16 x3. Live main, failing-check and multi x3 all exit 0.
  - Parent spot check: control-plane `npm test` 92/92. Auth: POST reset/config 403 without the key; GET state/events 200. Live main exit 0 (prediction 2/1, cutoffs 2, squashes 3, retired 3), no tokens in the output.
  - The admin key exists only in the gitignored `app/control-plane/.secret-admin-key` and as a Worker secret; verified absent from the tracked tree.
- [x] T20 (D) Docs sync for admin-key auth and T19 hardening (Claude Sonnet subagent). Commit `8e6efc1`. Parent check: the admin key is absent from README/docs.
- [x] T10 (I) Final verification, feature-document update, morning hand-off (2026-10-13).
  - Incident: a scripted edit of this document used an empty slice, which interleaved text into an 11 MB corrupt file in commit `6314bb2` (pushed). Restored from `b3c1d28` and the edits re-applied by hand. The corrupt blob stays in remote history (not rewritten: force-push is the owner's call).

Route declaration: T2-T7 are delegated because each package is non-trivial and the six run in parallel in disjoint directories. That is the writer trigger plus the user's explicit request to use many Devin agents. T8 and T9 each go to one writer, because they touch multiple packages.

## Progress / evidence
- 2026-10-13: T0 done (`f62b940`). RDD is on by default; candidate-review consent requires the user, so reviews are queued for the morning.

- 2026-10-13: T1 done (`dfe4704`). T2-T7 were dispatched in parallel to six SWE-2 writers (devin -p, permission-mode dangerous, 2h time box). Logs: `odd/logs/T*.out` (gitignored).

- 2026-10-13: T2-T7 complete and pushed to `origin/feat/agent-reorder-buffer` (remote set by the user). T8, T9a and T9b dispatched in parallel.

- 2026-10-13 ~08:00 UTC: Devin's free SWE-2 hit its rate limit ("Reached free model rate limit", reset 08:36 UTC). It cut T11 and T12 mid-task, and T11's partial work in `rob.ts`/`rob.test.ts` is uncommitted.
  - T12 was handed to a Claude subagent (bench/** only).
  - T11 resumes automatically at 08:38 UTC with SWE-2 max (`odd/prompts/T11b-resume.md`).
  - SWE-2 is NOT unlimited: pace parallel SWE-2 runs.

## Status at hand-off (2026-10-13)
Acceptance criteria:
1. `npm run demo` drives the organizers' scenario end to end: MET. Live, verified by the parent several times; the latest is on `demo-stable-4`.
2. A body-only push gives an early cutoff: MET. `earlyCutoffs=2` live.
3. Dynamic Worker checks gate retirement: MET. `failing-check` blocks, then retires after the fix.
4. Live dashboard: MET. Screenshots are in `app/dashboard/screenshots/`; footage is local only.
5. README with run steps and mocked parts: MET. A fresh clone followed it in T18.

Stretch delivered: value prediction (2 hit / 1 miss), per-component sharding with index maps (flat 2-3 µs per event in the benchmark), atomic trunk retirement, admin-key auth, and self-healing (alarm sweep).

Known-good: tag `demo-stable-4`, Worker `9a6c1738-47f0-481e-b0cb-268d8330b4af`.

## Needs the owner's decision
1. RDD review consent for the work-unit commits. All of them are pending; the parallel writers' untracked files made assessment unassessable overnight.
2. Delivery: PR from `feat/agent-reorder-buffer` to `main`, the chain strategy (forecast well over 400 lines), and the merge. Nothing was merged.
3. Submission (deadline 2026-10-14):
   - record the 5-10 min video, using `docs/demo-script.md` and the local footage in `app/dashboard/recordings/` (recorded before T19, still valid visually);
   - submit the repo URL.
4. Clean up the throwaway Cloudflare resources (the `spike-*` and `arb-test-*` Workers and repos, listed in `spikes/SPIKES.md` and the NOTES).
5. The admin key lives in the gitignored `app/control-plane/.secret-admin-key`. Back it up and do not commit it.
6. Optionally rewrite history to drop the 11 MB corrupt blob from commit `6314bb2`. It needs a force-push.
7. The Fable review the owner planned.

## Next step
Owner review in the morning. Then the PR, the video and the submission.
