# app/checker — run a commit's tests inside a Dynamic Worker

Implements `runChecks(env, repo, commit)` from `app/CONTRACTS.md`: reads every file at the
commit from Artifacts, strips TypeScript, loads the tree as a Dynamic Worker via the Worker
Loader binding, and runs every `tests/**/*.test.{ts,js,mjs}` module's exported `run()`.

## Layout

- `src/index.ts` — `runChecks`, `CheckerEnv`, `CheckResult`. Never throws.
- `src/module-map.ts` — `buildModuleMap(repo, commit)`: resolves the commit via
  `repo.log({ref, limit:1})`, walks `readTree`/`readBlob` into a WorkerLoader `modules` map.
- `src/strip-types.ts` — `stripTypes(code, path)` via sucrase (`transforms: ["typescript"]`,
  `keepUnusedImports: true`).
- `src/runner.ts` — `buildRunnerSource(testModules)` generates the entrypoint module
  (`__arb_checker__.mjs`) with one static import per test module.
- `src/test-worker.ts` + `wrangler.jsonc` — the throwaway `arb-test-checker` Worker
  (`GET /check?repo=&commit=`).
- `test/*.test.ts` — Node unit tests (`node:test`) with an in-memory fake repo.
- `fixture/` — the TS fixture pushed to `arb-test-checker-fixture`.

## Run / test / deploy

```sh
npm install
npm test                      # node --experimental-strip-types --test test/*.test.ts
npm run typecheck             # tsc --noEmit
npx wrangler deploy           # deploys arb-test-checker to workers.dev
```

Proof requests:

```sh
curl "https://arb-test-checker.lautitomasalejo.workers.dev/check?repo=arb-test-checker-fixture&commit=<sha>"
# passing commit 241d6978ee14816a6acb162a78d4f129c45082b7 -> {passed:4, failed:0}
# failing commit 7097b6f95de47d22ad5641a124234602176942fc -> {passed:2, failed:2}
```

## Decisions

- **TS strip: sucrase** (pure JS, no WASM/Node deps; bundles to ~80 KiB gzip inside the
  worker). `ts-blank-space` was rejected: it needs the multi-MB `typescript` parser package,
  and `ts-blank-space-lite` handles inline `import { type X }` specifiers less robustly.
  `keepUnusedImports: true` keeps unused-looking value imports (module side effects), matching
  Node's own strip-types semantics; `import type` and inline `type` specifiers are still removed.
- **`.ts` specifiers kept, modules keyed by original path.** Modules are stored as
  `{ js: strippedCode }` under their real repo path (`src/api/order.ts`), so
  `import "../src/api/order.ts"` resolves with zero specifier rewriting — exactly the fixture
  convention in CONTRACTS.md. Non-TS files map to `{ cjs }` / `{ json }` / `{ text }` /
  `{ data }` by extension.
- **Synthesized runner module.** Dynamic `import()` cannot resolve against a loader module
  map, so `__arb_checker__.mjs` statically imports each test module and default-exports a
  `fetch` that calls `run()` per module and returns `{ results }`. If the repo ever contains a
  file at that path it is overwritten in the map (collision is harmless — document only).
- **Result names are prefixed** with the module path (`tests/order.test.ts: computes total`)
  so failures are attributable when several suites run. A thrown error, a missing `run()`, or a
  non-array return produces one failed entry named after the module path.
- **Commit resolution via `log({ref})`** — accepts sha, branch or tag; the returned `hash` and
  `treeHash` are used directly. `CheckResult.commit` is always the resolved full sha.
- **Loader cache id = `arb-checker:<repo>:<resolvedSha>`** — same commit reuses the same
  `LOADER.get` id (per-machine isolate cache; misses just re-run the module-map build).
- **`durationMs`** is measured in the calling worker around the whole `runChecks` body
  (repo resolve + isolate + test run). On a warm isolate hit it reflects just the run.
- Test glob is `tests/**/*.test.{ts,js,mjs}` — `.ts` per contract, `.js`/`.mjs` accepted since
  they run unmodified. A commit with zero test modules yields `{passed:0, failed:0}`.
- `globalOutbound: null` — test code cannot make network calls.

## Measured (deployed `arb-test-checker`, curl, 2026-10-13)

| request | result | durationMs |
|---|---|---|
| pass commit, cold | 4/4 pass | 261 |
| fail commit, cold | 2 pass / 2 fail, messages intact | 424 |
| pass commit repeats | 4/4 | 260 / 662 / 5175 / 7739 |
| unknown commit sha | failed check, `commit not found` | 657 |
| unknown repo | failed check, `ArtifactsError: Repository not found` | 39 |

The multi-second repeats are per-machine `LOADER.get` cache misses (callback re-runs the
Artifacts walk + isolate start on a fresh machine) plus occasional platform slowness — same
behaviour spike 5b measured. Cache hits land in the few-hundred-ms band.

## Contract issues

None. `CheckerEnv`/`runChecks` match CONTRACTS.md exactly.

## Cloudflare resources created

- Worker `arb-test-checker` (bindings: `ARTIFACTS` → namespace `arb`, `LOADER`).
- Artifacts repo `arb-test-checker-fixture` in namespace `arb`, branch `main`; two commits
  (`241d6978…` passing, `7097b6f9…` failing). Pushed with the repo's create-time write token.

## Known gaps

- `LOADER.get` cache is per-machine: a cold machine re-runs the module-map build; worst
  observed ~7.7 s end-to-end. Retrying is cheap and safe.
- Tree walk is serial (`readTree`/`readBlob` per object, like spike 5b); large repos could
  batch blob reads.
- `symlink`/`gitlink` tree entries are skipped.
- If module instantiation itself fails (syntax error after stripping, unresolved specifier),
  the whole check reports one failed `checker` entry rather than per-module detail.
