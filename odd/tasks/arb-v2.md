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
Known-good: tag `demo-stable-5` (`dfc05ea`), Worker version `b3e47042-6c08-467a-b947-3350a0b7ce40`. Live main passed on it (68 s, 3 retired).

## Delivery strategy
`exception-ok`: forecast is about 1,800 authored lines, above the 400-line budget. Reason: hackathon deadline, and the user authorized pushing to `main` once it works. Each task still lands as its own work-unit commit.

## Tasks
Route legend: D = delegated writer, I = inline (orchestrator), A = audit (Sonnet subagent).

- [x] V0 (I) Contracts V2 in `app/CONTRACTS.md`; this document. Inline: one already-understood file.
- [ ] V1 (D, SWE-2) Hasher: `extractImports`, `SymbolSignature.file/bodyHash/source`. Surface `app/hasher/**`. Prompt `odd/prompts/V1-hasher.md`.
- [ ] V2 (D, SWE-2) MCP server `app/mcp/`. Prompt `odd/prompts/V2-mcp.md`.
- [ ] V3 (D, SWE-2) Control plane: inference, Jev client, judge flow, stats, sweep, router aggregation. No deploy. Prompt `odd/prompts/V3-control-plane.md`.
- [ ] V5 (D, Codex gpt-6.1-sol) Dashboard rendering of V2 events + mock replay. Prompt `odd/prompts/V5-dashboard.md`.
- [ ] V4 (D, SWE-2) Integration after V1+V3: real hasher wiring, demo behavior-change beat, deploy with bumped DO names, live runs.
- [ ] V6 (A) Sonnet audit per landed unit (V1, V2, V3, V4).
- [ ] V7 (D) Docs: README, `docs/architecture.md`, `docs/demo-script.md`.
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
