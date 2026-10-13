First read `odd/prompts/_builder_head.md` completely and follow every rule in it. Then do the task below.

# Task T3: `app/checker`, run a commit's tests inside a Dynamic Worker

## Allowed edit surfaces
app/checker/**

## Requirements
- Implement `runChecks(env, repo, commit)` exactly as in `app/CONTRACTS.md`.
- Reuse spike 5b (`spikes/5b/`): tree reading via `readTree`/`readBlob` (or `readFile`), module map building, and `env.LOADER.get(id, ...)`/`load`.
- TypeScript: strip types inside the Worker before loading. Use a pure-JS transformer that works in Workers with no dynamic WASM compile (e.g. `sucrase` with `transforms: ["typescript"]`, or `ts-blank-space`), and verify it inside a deployed Worker.
- Import specifiers keep their `.ts` extension ("Fixture convention" in CONTRACTS). Make the module map resolve them: key modules by their original `.ts` path with an explicit JS module type (e.g. `{ js: code }`), or rewrite specifiers. Document the choice.
- Run every `tests/**/*.test.ts` module's exported `run()`, aggregate into a `CheckResult` with `durationMs`. A thrown error or missing `run` counts as a failed check with an error message. Never throw from `runChecks`.
- Cache by commit: the same commit uses the same `LOADER.get` id.
- Tests:
  - Unit tests for the module-map builder and TS strip, runnable in Node.
  - A deployed throwaway Worker `arb-test-checker` (bindings: ARTIFACTS namespace `arb`, LOADER) that runs checks on a test repo `arb-test-checker-fixture`. Create that repo and push a small TS fixture to it.
  - Prove one passing commit and one failing commit with curl. Record timings in NOTES.md.
