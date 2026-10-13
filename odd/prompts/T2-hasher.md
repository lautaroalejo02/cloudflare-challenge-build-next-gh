First read `odd/prompts/_builder_head.md` completely and follow every rule in it. Then do the task below.

# Task T2: `app/hasher`, exported-interface hashing for TypeScript that runs INSIDE a Cloudflare Worker

## Allowed edit surfaces
app/hasher/**

## Requirements
- Implement `hashInterface(files)` exactly as specified in `app/CONTRACTS.md` (`app/hasher/src/index.ts`).
- Use web-tree-sitter with the TypeScript grammar, reusing spike 6:
  - its working Worker init pattern (`spikes/6/src`: CompiledWasm import + `instantiateWasm` hook);
  - its patched `tree-sitter-typescript.wasm` with the `dylink.0` section (copy it into app/hasher).
- The module must be importable by another Worker (the control plane) via a relative path. Either expose an explicit `initHasher(runtimeWasm, grammarWasm)`, or lazy-init with wasm modules imported by the hasher itself. Document the choice in NOTES.md so the integration agent can wire it.
- Normalization: same rules as spike 4 (see `spikes/4/test/run.js` and `spikes/4/bin/hash-interface.js`).
  - Same hash for: reformatting, comments, body-only changes, declaration reorder.
  - Different hash for: param type change, added param, return type change, interface field change.
  - Cover exported functions, exported const arrow functions, type aliases, interfaces, and classes' public members.
- Per-symbol hashes and signature text are required: the control plane shows "createOrder#a91f" and old vs new signature in a squash diagnosis.
- Tests: a Node test suite exercising the same module and wasm (load the wasm from disk in Node), covering all 7 cases plus per-symbol hashes.
- Proof inside a real Worker: deploy throwaway Worker `arb-test-hasher` that accepts the fixture via POST and returns hashes. Run the 7 cases through it with curl, and record the results plus CPU time (via `wrangler tail`) in NOTES.md.
