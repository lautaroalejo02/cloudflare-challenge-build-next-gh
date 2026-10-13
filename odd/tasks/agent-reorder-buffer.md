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
- [ ] T1 (I) Write `app/CONTRACTS.md` and this document.
- [ ] T2 (D) `app/hasher`: tree-sitter TS exported-interface hash for Workers, with tests (reuses spike 4 rules + spike 6 wasm).
- [ ] T3 (D) `app/checker`: run commit tests in a Dynamic Worker with TS stripping, with a deployed proof.
- [ ] T4 (D) `app/demo`: fixture app + scripted agents + scenario runner + mock control plane for its own tests.
- [ ] T5 (D) `app/dashboard`: static pipeline UI with mock event replay.
- [ ] T6 (D) `app/control-plane`: Worker + ReorderBuffer DO + queue consumer + API; pure, unit-tested ROB state machine (`src/rob.ts`).
- [ ] T7 (D) `app/retirer-spike`: prove fast-forward retirement from a fork to `arb-trunk` main from a Worker (isomorphic-git), with timings.
- [ ] T8 (D) Integration: wire hasher, checker and retirer into control-plane; deploy; run the scenario end to end; fix.
- [ ] T9 (D) Demo hardening: stats, early-cutoff scene, failing-check scene, veto, robSize; README + run instructions + video script.
- [ ] T10 (I) Final verification, feature-document update, morning hand-off.

Route declaration: T2-T7 are delegated because each package is non-trivial and the six run in parallel in disjoint directories. That is the writer trigger plus the user's explicit request to use many Devin agents. T8 and T9 each go to one writer, because they touch multiple packages.

## Progress / evidence
- 2026-10-13: T0 done (`f62b940`). RDD is on by default; candidate-review consent requires the user, so reviews are queued for the morning.

## Next step
Dispatch T2-T7 in parallel.
