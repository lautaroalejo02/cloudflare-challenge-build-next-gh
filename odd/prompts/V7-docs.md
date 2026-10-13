First read `odd/prompts/_builder_head.md` completely and follow every rule in it. Then read:
- `odd/tasks/arb-v2.md` completely;
- the "(V2)" items and the changelog in `app/CONTRACTS.md`;
- `app/control-plane/NOTES.md` sections "V2 (inference + Jev)", "V3b audit fixes", "V2 integration (V4)" and "V8 inference scope";
- `app/mcp/README.md` and `app/mcp/NOTES.md`;
- `app/hasher/NOTES.md` "V2" and "V1b";
- the current `README.md`, `docs/architecture.md`, `docs/demo-script.md` and `app/control-plane/bench/RESULTS.md`.

Do not deploy. Do not run live scenarios.

# Task V7: Document ARB v2 for hackathon judges

## Allowed edit surfaces
README.md
docs/**
app/control-plane/bench/RESULTS.md

## What to document (only what exists and was measured; cite the NOTES section for every number)
1. **README.**
   - A short "What's new in v2" near the top:
     - dependency inference from imports, limited to files the agent changed;
     - the semantic squash: TypeSafe Jev judges body-only changes to consumed symbols, with the 0.7 / 0.4 thresholds and v1 behavior when unavailable;
     - the MCP server that lets any coding agent join.
   - Measured live results, as one table from V4 + V8: refactor judged 0.02 (clear) vs VAT behavior change 0.93-0.97 (squash), consistent across runs; Jev latency of about 1-2 s per judgment; inference diff cost median 134 ms / max 166 ms live.
   - A "Try it with your own agent" section: point to `app/mcp/README.md` and show the `claude mcp add` one-liner.
   - Honesty notes:
     - the demo agents are scripted, but the Artifacts forks, hashing, Jev calls, tests in Dynamic Workers and retirement are real;
     - Jev is a third-party API (TypeSafe) and needs a `TYPESAFE_API_KEY` Worker secret;
     - the scope limits: TypeScript only, and undeclared dependencies are reported, not re-forked.
   - Setup: how to set the `TYPESAFE_API_KEY` secret by piping a file into `npx wrangler secret put TYPESAFE_API_KEY`, never with the value on the command line, and mention the gitignored `.secret-typesafe-key` convention. Never include any key value.
   - Update the measured-numbers section. Main now takes about 90-100 s, the stats line has the V2 fields, and main shows 1 prediction hit / 0 misses (the prediction-miss beat now appears in multi).
2. **`app/control-plane/bench/RESULTS.md`.** Add a "V2 (same machine comparison)" section:
   - single mode at N=100k: v1 `a634b36` median 10.3 µs / p95 78.3 µs vs v2 median 19.1 µs / p95 79.7 µs, from the orchestrator's measurement on 2026-10-13 (`odd/tasks/arb-v2.md`, V3b entry);
   - the older 2.1-2.7 µs numbers came from an earlier, quieter run, so they must not be compared directly.

   Fix any README claim that quotes 2.7 µs for the current code.
3. **`docs/architecture.md`.**
   - Add the V2 flow: push → hasher (interface hash + bodyHash + imports) → inference → judge effect → Jev → `judge.done` (staleness rules) → squash/warn/clear.
   - Describe the source store and the MCP adapter's place.
   - Include one small ASCII or mermaid diagram.
4. **`docs/demo-script.md`.** Revise it for a 5-8 minute video. Add:
   - the Jev beat, after the refactor's early cutoff: "same signature, behavior changed": the VAT change, Jev p≈0.95, UI and tests squashed with the diagnosis, then the redo;
   - a 30-45 s MCP scene: a real coding agent registering through `arb_register` and appearing on the dashboard, marked as optional if not recorded;
   - updated timings, since main is about 90-100 s.

   Keep the admin-key warning (keep `?key=` off camera).

## Rules
- Never claim beyond the evidence. Wherever a number has no source in NOTES, `odd/tasks/arb-v2.md` or `bench/RESULTS.md`, omit it.
- English, concise, scannable. Keep the existing structure. Do not rewrite unrelated sections.

## Verification
- Grep the changed docs for `2.7` and check that each remaining mention is explicitly v1 / historical.
- Grep for `art_v2_`, `Bearer ` and any 30+ char random-looking string. There must be no secrets.
- Run every command in the README "run" section that needs no Cloudflare credentials (package `npm test`s, the mock demo). Report the results.
- Final message: `## Result`, the commands with observed results, and the files changed.
