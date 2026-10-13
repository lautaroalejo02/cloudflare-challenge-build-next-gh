# spike-5b — Can a Worker run a test function from code stored in Artifacts via Dynamic Workers (Worker Loader), no bundler?

Verdict: WORKS

## Measured (in-worker `performance.now()`, deployed Worker, ~16 requests)
- Artifacts `repo.get()` handle: 21–485ms (first/cold ~485, warm 21–190)
- Module map build (`log` + 3×`readTree` + 3×`readBlob` = 6 RPC calls, 3 modules): 51–241ms
- `LOADER.load()` + isolate start + first fetch: 13–33ms
- `LOADER.get(id)` cold (callback runs, map built inside): 63–257ms end-to-end
- `LOADER.get(id)` warm (same id, callback skipped, isolate reused): firstFetch 3–4ms
- Re-invoke on same stub (`ep.fetch` again): 0–4ms; test run itself <1ms (4 assertions)
- Result: dynamic worker ran `test/order.test.js` `run()` → `{total:4, passed:4, failed:0}`

## Reproduce
1. `wrangler artifacts repos create spike-5b-fixture --namespace spike-5b --default-branch main`
2. `git -c http.extraHeader="Authorization: Bearer <token>" push <remote> HEAD:main` (files: src/order.js, src/consumer.js, test/order.test.js — plain ESM, `run()` + default `fetch` export)
3. Worker `wrangler.jsonc`: `"worker_loaders":[{"binding":"LOADER"}]`, `"artifacts":[{"binding":"ARTIFACTS","namespace":"spike-5b"}]`; compat 2026-10-12
4. Worker: `using repo = await env.ARTIFACTS.get(repo)` → `repo.log({ref:"main",limit:1})` → recurse `readTree(commit.treeHash)`/`readBlob` into `modules` map → `env.LOADER.get(id, () => ({compatibilityDate, mainModule:"test/order.test.js", modules, globalOutbound:null}))` → `stub.getEntrypoint().fetch(...)`
5. `curl https://spike-5b-runner.lautitomasalejo.workers.dev/run?mode=get|load`

## Caveats
- Relative ESM imports between `modules` entries resolve by path — no bundler needed for dependency-free JS.
- `get()` isolate cache is per-machine: callback ran on ~8/10 requests even seconds apart; warm hits only when same isolate is reached. Not a correctness issue.
- One transient `error code: 1104` in ~16 requests.
- `node:test` unavailable in Workers — test file must self-export `run()`; `using` (Disposable) required for repo handle.
- Limits not hit: module count/size limits NOT MEASURED (3 modules, ~2KB). No extra compat flags or beta access needed beyond paid plan.

## Cloudflare resources created
- Worker: `spike-5b-runner` | Namespace: `spike-5b` | Repo: `spike-5b/spike-5b-fixture` | Token: `art_v2_…` (expires 1791945194)

Recommendation: viable — skip bundlers for plain-ESM repos; use `LOADER.get(commit-hash)` for warm reuse and accept per-machine cache misses.
