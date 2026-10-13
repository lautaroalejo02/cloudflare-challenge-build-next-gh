# Spikes: Cloudflare Workers + Artifacts feasibility (2026-10-12)

Eight throwaway spikes, each run by an independent SWE-2 agent in `spikes/<id>/`. Full reports: `spikes/<id>/REPORT.md`. Every number below was measured in a real run; anything not measured is marked NOT MEASURED. Spot checks by the orchestrator: spike 4 (`npm test` re-run, 7/7 PASS, same hash) and spike 5b (live `curl` to the deployed Worker, 4/4 tests pass, map 95 ms, isolate 18 ms).

**Overall: GO.** Every platform assumption behind Agent Reorder Buffer holds.

| Spike | Question | Verdict | Key numbers |
|---|---|---|---|
| 1 | Create repo, mint token, git push, `readFile` from Worker | WORKS | Full cycle median 4.28 s (3.35-5.98, n=6), pass bar 10 s. `create()` is the slowest step (1.0-2.9 s). Read-after-push consistent every run. |
| 2a | `cf.artifacts.repo.pushed` event latency | WORKS | Median 3.77 s, max 5.88 s (n=10, clock skew ~240 ms corrected). All 10 events arrived. |
| 2b | Fallback: DO alarm polls `repo.log({limit:1})` every 2 s | WORKS | Detection median 0.70 s, max 1.52 s (n=10). ~1,730 log calls and ~31 s DO wall time per repo-hour. Skew not corrected. |
| 3 | Fork, fork-of-fork, 10-fork burst | WORKS | fork 1.9-2.4 s. Fork-of-fork works and carries the fork's new commit. Default fork copies ALL branches (`defaultBranchOnly` opt-out). 10 parallel forks: 1.9 s wall, no rate limit. |
| 4 | `hash-interface` (ts-morph, Node) | WORKS | 7/7 cases pass (format, comments, body, reorder = same; param, return, field = different). ~9 ms/hash in-process, ~650 ms cold CLI. |
| 5a | `npm test` on a fork via Sandbox SDK | WORKS | Warm 18.8-20.7 s (pass bar 30 s), cold 39.6 s. The test itself runs in 240 ms; npm startup dominates. |
| 5b | Run tests from Artifacts code in Dynamic Workers, no bundler | WORKS | Module map 51-241 ms, isolate load 13-33 ms, warm reuse ~3 ms. Plain ESM only. |
| 6 (extra) | web-tree-sitter + TS grammar inside a Worker | WORKS WITH CAVEATS | Bundle 2.65 MiB (329 KiB gzip) vs 64 MiB limit. 28-64 ms CPU per small request. Grammar wasm needed a `dylink.0` fix. |

## Caveats that change the build
- **Wrangler version:** 4.145.0 cannot create repo-scoped event subscriptions (missing `--source-namespace` / `--source-repo-name`). Use >= 4.149.0 (2a).
- **Event delivery:** events arrive in batches. The consumer used `max_batch_timeout=5`; lowering it may cut max latency (NOT MEASURED) (2a).
- **Repo handles:** `ArtifactsRepo` is a disposable RPC handle (`using`). `readFile` returns a `Blob` (`.text()`) (1, 5b).
- **Git auth:** prefer `https://x:<token>@host/...` with the `?expires=` suffix stripped, plus `GIT_TERMINAL_PROMPT=0`. Bearer `extraHeader` worked for push but hung on `ls-remote` (3).
- **Transient errors:** one `1042` on the first request after deploy (3) and one `1104` in ~16 requests (5b). Retry once.
- **Dynamic Workers:** code must be plain ESM with no deps, and `node:test` is unavailable, so tests self-export `run()`. The `LOADER.get()` cache is per machine (5b).
- **Sandbox image push:** `docker push` to `registry.cloudflare.com` breaks through the Docker Desktop proxy. Workaround: chunked upload (>= 5 MiB parts) and reference the pre-pushed image URI in `containers[].image` (5a).
- **WASM in Workers:** dynamic compilation is banned. Import `.wasm` as a `CompiledWasm` module with an `instantiateWasm` hook, and build the grammar with `tree-sitter build --wasm` instead of patching the binary (6).
- **Timers:** in-Worker `Date.now()` / `performance.now()` freeze during synchronous CPU work. Measure CPU via `wrangler tail` cpuTime; timings around awaited I/O are fine (6).

## Recommendation for the real build
- Use push events for change propagation, and DO polling only on the trunk repo if sub-second UI feedback is needed.
- Fork per agent freely.
- Hash interfaces with ts-morph in a Sandbox/Node step, or with tree-sitter in a Worker.
- Run fast checks in Dynamic Workers, and use Sandbox only for full npm suites.

## Cloudflare resources created (to clean up later)
- Workers: `spike-1-artifacts-rt`, `spike-2a-consumer`, `spike-2b-poller`, `spike-3-artifacts`, `spike-5a`, `spike-5b-runner`, `spike-6-tree-sitter`.
- Artifacts namespaces: `spike-1`, `spike-2a-ns`, `spike-2b`, `spike-3` (23 repos), `spike-5a`, `spike-5b`.
- Queue `spike-2a-queue` and subscription `spike-2a-push-sub`; KV `spike-2a-kv`; container app `spike-5a-spike5asandbox`.
