# Feature: ARB v2 — dependency inference, Jev semantic squash, MCP adapter

Locator: `odd/tasks/arb-v2.md` · Engram mirror: `odd/arb-v2/tasks` · Branch: `feat/arb-v2` (from `dfc05ea`)

## Objective
Make the Agent Reorder Buffer usable by real agents without hand-written wiring, and close its biggest semantic gap:
1. Agents no longer declare `consumes`; it is inferred from imports.
2. Body-only changes that alter behavior are caught: TypeSafe Jev judges them and squashes consumers when needed.
3. Any MCP-capable agent (Claude Code, Codex, Devin) can join the buffer through an MCP server.

## Why
The v1 demo needs scripted dependency declarations and is blind to same-signature behavior changes. Those were the two honest gaps named to the user. The hackathon deadline is 2026-10-14 23:00 PT.

## Scope
- In: `extractImports` + `bodyHash`/`source` in the hasher; inference and the Jev judge flow in the control plane; `app/mcp/` server; dashboard rendering of V2 events; demo beat for a behavior change; docs.
- Out: automatic re-fork on undeclared dependencies (reported only); Jev producer routing from task text (stretch S1); non-TypeScript languages.

## Constraints
- Contracts: `app/CONTRACTS.md` V2 sections are the source of truth.
- Secrets: `TYPESAFE_API_KEY` only as a Worker secret and in the gitignored `app/control-plane/.secret-typesafe-key`; never printed or committed. Same rule as `ARB_ADMIN_KEY`.
- The v1 demo must keep passing. Jev unavailable means v1 behavior.
- Max 3 concurrent SWE-2 runs (rate-limit lesson from v1).

## Safety net
Known-good: tag `demo-stable-7` (`6c1b760`), Worker version `e72a037b-6c00-4edd-a933-d160f84d78e1`; V2 + V8 live main passed 2/2. Earlier: `demo-stable-6`, Worker `9f105998-1985-432d-af28-df1908c3d014`. Previous: `demo-stable-5`, Worker `b3e47042-6c08-467a-b947-3350a0b7ce40` (v1 + redesign).

## Delivery strategy
`exception-ok`: forecast is about 1,800 authored lines, above the 400-line budget. Reason: hackathon deadline, and the user authorized pushing to `main` once it works. Each task still lands as its own work-unit commit.

## Tasks
Route legend: D = delegated writer, I = inline (orchestrator), A = audit (Sonnet subagent).

- [x] V0 (I) Contracts V2 in `app/CONTRACTS.md`; this document. Inline: one already-understood file.
- [x] V1 (D, SWE-2) Hasher: `extractImports`, `SymbolSignature.file/bodyHash/source`. Surface `app/hasher/**`. Prompt `odd/prompts/V1-hasher.md`. Done `f01087f`: ALL PASS (parent re-ran), base hash unchanged `f9916f523525`, extractImports adds 1.17x. Sonnet audit: no blockers, 4 majors. False bodyHash on reformat, default-export identifier, cross-file dedupe and from/file path form.
- [x] V1b (D, SWE-2) Fix the V1 audit majors and the export-star-as and overload minors; remove the flaky perf assertion. Prompt `odd/prompts/V1b-hasher-audit-fixes.md`. Done `7b533a6`: ALL PASS, base hash unchanged (parent re-ran); control-plane `tsc --noEmit` is clean again.
- [x] V2 (D, SWE-2) MCP server `app/mcp/`. Prompt `odd/prompts/V2-mcp.md`. Done `04f4d66`: 10/10 tests (parent re-ran; integration drives register → squash → sync → retired on the mock); the token scan finds only fake test tokens. Sonnet audit: no blockers, 4 majors. Token in the git argv/hooks, entryId path traversal, fork re-adopted without a re-clone, orphaned entry on a failed clone.
- [x] V2b (D, SWE-2) Fix the MCP audit majors and minors 5-10. Prompt `odd/prompts/V2b-mcp-audit-fixes.md`. Done `03dba3b`: 25/25 tests (parent re-ran); the secret scan is clean. Live check against real Artifacts passed: clone and push through the `http.extraHeader` Basic credential, no token in `.git/config`, the entry retired.
- [x] V3 (D, SWE-2) Control plane: inference, Jev client, judge flow, stats, sweep, router aggregation. No deploy. Prompt `odd/prompts/V3-control-plane.md`. Done `f70c0be`: 124/124 tests (parent re-ran; the 92 v1 tests stay green); the wrangler dry-run builds. Sonnet audit found 1 BLOCKER: unbound `globalThis.fetch` means Jev always fails in workerd. It also found 5 majors (stale verdict loses the net change, no live-producer check, wrong forkedExports baseline, false deps.undeclared, usage selection) and minors (source store growth, body timeout, prototype names, hot-path allocation).
- [ ] V3b (D) Fix the control-plane audit findings 1-10. Prompt `odd/prompts/V3b-control-plane-audit-fixes.md`. The first SWE-2 run hit the free rate limit before editing anything (`odd/logs/V3b.err`). Re-routed to Codex gpt-6.1-sol (`odd/logs/V3b-codex.out`). Done `45d2b03`: 155/155 tests (parent re-ran), tsc clean, the dry-run builds. Parent bench at N=100k in single mode on the same machine: v1 `a634b36` median 10.3 µs / p95 78.3 µs vs v2 median 19.1 µs / p95 79.7 µs (about 1.9x median, flat p95). The recorded 2.7 µs came from an earlier, quieter run; docs must quote the same-machine comparison, not 2.7 µs for v2.
- [x] V5 (D, Codex gpt-6.1-sol) Dashboard rendering of V2 events + mock replay. Prompt `odd/prompts/V5-dashboard.md`. Done `4fab37a`: 44/44 dashboard tests (parent re-ran), screenshots `app/dashboard/screenshots/v2-*.png`. Live check pending V4.
- [x] V4 (D, Devin `claude-opus-5-5-medium`; the user approved spending Pro quota on 2026-10-13 because SWE-2's free rate limit could cut a deploy) Integration after V1b+V3b: real hasher wiring, demo behavior-change beat, deploy with bumped DO names, live runs. Prompt: `odd/prompts/V4-integration.md`.
  - Done `a16239e`, Worker `9f105998-1985-432d-af28-df1908c3d014`.
  - Live: main x3, failing-check and multi all exit 0.
  - Jev on `createOrder`: the refactor judged 0.02 (clear) and the VAT behavior change 0.93-0.97 (squash), in 4 of 4 runs that contain the beat.
  - Parent spot check: 156/156 control-plane and 18/18 demo tests; reset without the key returns 403; the live events have 0 `art_v2_` and 0 `Bearer`.
  - Pushed to `main` (`ce2d463`) and tagged `demo-stable-6`.
  - Known gap: inference reads imports from the whole entry tree, so the UI also inferred `charge` from an untouched trunk file. Main now shows 1 prediction hit / 0 misses, and runs take about 90-100 s.
- [x] V8 (D, Codex) Restrict inference to imports in files the entry changed since its `baseCommit`. Redeploy and run live. Prompt `odd/prompts/V8-inference-scope.md`.
  - Done `6c1b760`, Worker `e72a037b-6c00-4edd-a933-d160f84d78e1`, tag `demo-stable-7`, pushed to `main`.
  - Live: main x2, failing-check and multi all exit 0. The UI infers only `createOrder` and `Cart` (no `charge`). Jev: refactor 0.02 (clear), VAT 0.94/0.97 (squash). Diff cost median 134 ms, max 166 ms.
  - Parent re-ran the control-plane tests: 161/161.
- [ ] V9 (D, Codex gpt-6.1-sol) Silent 1080p demo video (5:30-6:30) recorded from live scenarios, with burned-in captions and a cue sheet so the user narrates. The user asked for this on 2026-10-13. Prompt `odd/prompts/V9-video.md`. Output in `video/out/` (gitignored).
- [ ] V6 (A) Sonnet audit per landed unit (V1, V2, V3, V4).
- [x] V7 (D, SWE-2 high) Docs: README, `docs/architecture.md`, `docs/demo-script.md`, `bench/RESULTS.md` v2 section. The agent finished its result, then the process hung and hit the 2 h background limit; nothing was lost. Parent checks: every 2.7 µs mention is labeled v1-era, the secret grep is clean, and the scratch `app/demo/tmp-mock` was moved to `tmp/`.
- [ ] S1 (stretch) Jev producer routing from `task` text.

Route declaration: V1, V2, V3 and V5 are delegated because each one is a non-trivial multi-file package and they run in parallel in disjoint directories (writer trigger + user's explicit request for parallel SWE-2/Sol agents).

## Acceptance criteria
- All package suites green: hasher, control-plane, checker, demo, dashboard, mcp.
- Live: main, failing-check and multi exit 0 on the V2 deploy; main shows one `behavior-changed` squash with a Jev probability when the key is set, and plain v1 behavior when it is not.
- MCP: an integration test drives register → push → squash → sync → ready → retired against the mock server.
- No secret value in git, logs or events.

## Progress
- 2026-10-13: redesign `dfc05ea` fast-forwarded to `main` and deployed (`b3e47042`); live main passed. V0 done.

## Next step
Launch V1, V2, V3 (SWE-2) and V5 (Codex) in parallel.
