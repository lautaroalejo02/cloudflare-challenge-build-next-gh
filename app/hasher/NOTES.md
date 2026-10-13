# app/hasher — exported-interface hashing for TypeScript inside a Worker

Implements `hashInterface(files): Promise<InterfaceHash>` exactly per
`app/CONTRACTS.md` from `src/index.ts`, using web-tree-sitter + the TypeScript
grammar (spike 6's runtime wasm + patched `tree-sitter-typescript.wasm` with
the `dylink.0` section, copied verbatim into `src/`). Normalization is a port
of spike 4's ts-morph rules to tree-sitter.

## Integration choice (for the control-plane agent)

**Both** init modes are provided; the recommended one is lazy-init:

- **Lazy (recommended).** `import { hashInterface } from "../hasher/src/index.ts"`.
  On first call it dynamic-imports `./wasm-modules.ts`, which statically
  imports both `.wasm` files. The consumer's wrangler.toml only needs
  `rules = [{ type = "CompiledWasm", globs = ["**/*.wasm"] }]` — the same rule
  spike 6 and `worker/wrangler.toml` use. No init code needed.
- **Explicit.** `initHasher(runtimeWasm, grammarWasm)` takes two
  `WebAssembly.Module` objects. `hashInterface` then never touches the dynamic
  import. This is what the Node test uses (wasm read from disk,
  `new WebAssembly.Module(bytes)`).

The parser is a process-global singleton (`??=`), so one warm parser is
reused across all calls in an isolate.

## Normalization rules (same semantics as spike 4)

Canonical text is rebuilt from tree-sitter leaf tokens: whitespace is
reconstructed from token boundaries, so reformatting never matters. Comments
and decorators are dropped. `;` terminators and `,` member separators inside
interface/object-type/enum/class bodies are dropped (ASI- and `,`-vs-`;`
insensitive). Function/method/arrow bodies are never emitted.

- Same hash: reformatting, comments, body-only changes, declaration reorder,
  private/protected/`#` class-member changes.
- Different hash: param type, added param, return type, interface field.
- Signature text per symbol is kept (e.g.
  `fn createOrder(cart:Cart,region:Region):Order`), so the control plane can
  show old vs new signature in a squash diagnosis.
- Symbol hash = `sha256(signature)[0:12]`; aggregate hash =
  `sha256(sorted "name signature" lines joined with \n)[0:12]`.
- Covered: exported functions, `export const` arrow/function expressions,
  type aliases, interfaces, enums (kind `"type"`), classes (public members
  only; members sorted like spike 4), `export default`, `export {a as b}`,
  `export {x} from "./f.ts"` and `export * from "./f.ts"` (resolved inside the
  `files` map), `declare` ambient declarations, function overloads (each
  overload is its own symbol entry).

## Known gaps / decisions

- No type checker: unannotated consts/returns get a small literal-based
  inference (number/string/boolean/template→string, regex→RegExp,
  `new X`→`X`, unary `-/+`→number, `!`→boolean, `as T`→T, arrays→`T[]`);
  anything else is `unknown`. Unannotated functions infer the union of
  top-level `return` expression kinds (`void` if none). This is deterministic
  but weaker than ts-morph's inference — a body-only change that alters the
  inferred kind can move the hash (e.g. `return 1` → `return "x"` with no
  annotation).
- File paths never enter signatures, so identical exports in two files
  dedupe; same-named symbols with different signatures both appear in
  `symbols` (the `SymbolHashes` record is last-write-wins downstream).
- `export * as ns from`, `export =`, and `export import` are not resolved
  (namespaces fall back to canonical text of the declaration).
- kind `"type"` covers type aliases, enums, and any unrecognized declaration.

## Run / test / deploy

```bash
npm install
npm test                      # node --experimental-strip-types test/run.mjs
node test/gen-payloads.mjs    # regenerate curl payloads
npm run deploy:test-worker    # deploys arb-test-hasher
curl -X POST https://arb-test-hasher.lautitomasalejo.workers.dev \
  -H 'content-type: application/json' --data-binary @test/payloads/base.json
npm run tail:test-worker      # wrangler tail arb-test-hasher --format json
```

## Verification

- `npm test`: 24/24 checks PASS — 7 spike-4 hash cases + private-member case,
  per-symbol kinds, `sha256(signature)[0:12]` verified independently via
  `node:crypto`, per-symbol diff isolation, path-independence, re-export
  resolution, unexported-symbol exclusion.
- Live Worker (`arb-test-hasher`, deployed 2026-10-13, upload 2669 KiB /
  gzip 333 KiB): all 9 cases POSTed via curl, HTTP 200, hashes byte-identical
  to the Node results. base/a_reformat/c_body/d1_reorder/priv →
  `f9916f523525`; b1→`4ce3769f80ec`, b2→`411edcc73fd9`, d2→`1b71a59ba8f5`,
  d3→`e3f4ad5af39c` (only `createOrder`/`Order` per-symbol hashes moved).
- CPU per request via `wrangler tail` (worker-side `cpuTime`):
  base 33 ms, a_reformat 33 ms, b1 37 ms, b2 3 ms, c_body 27 ms, d1 3 ms,
  d2 10 ms, d3 58 ms, priv 29 ms, a_reformat(retry) 32 ms — median ~30 ms,
  matching spike 6's 28–64 ms/req. Curl e2e mostly 0.12–1.0 s; one request
  took 20.7 s end-to-end with a normal 33 ms cpuTime (edge/network transient,
  consistent with the spike-noted 1042/1104-class flakiness).

## V2 (extractImports + file/bodyHash/source)

Implemented per CONTRACTS.md "(V2)" additions, additive only — every v1 hash
value is unchanged (base still `f9916f523525`, all per-symbol hashes and the
aggregate identical; the v1 checks run unmodified and green).

- `file`: repo-relative key of the file where the declaration physically
  lives. For `export {x} from`/`export * from` re-exports this is the TARGET
  file, not the re-exporting one.
- `bodyHash`: `sha256(canon(declNode, includeBodies=true))[0:12]` — the same
  `canon` walk as the interface hash (comments/decorators dropped, whitespace
  reconstructed, `;` dropped, `,` dropped inside interface/object/enum/class
  bodies) but function bodies, const initializers and all class member bodies
  are emitted. For multi-declarator statements (`const a=1,b=2`) each symbol's
  bodyHash covers only its own declarator. Whole-declaration coverage means
  private/`#` member bodies DO count (a private body change is a behavior
  change; the interface hash still ignores them).
- `source`: raw text of the top-level statement carrying the declaration
  (the `export_statement` when exported via `export <decl>`, so a leading
  `export`/`export default` is included; for `export {x}` of a local decl the
  bare declaration statement, which has no export keyword). Any contiguous
  run of immediately preceding comments is prepended, where "attached" means
  only whitespace between siblings and no blank line in the gap — so a
  trailing `// note` on the previous line also attaches. Truncated to 4000
  chars (applied at extraction AND at output).
- `extractImports(files)`: one `ImportRef` per `import_statement` and per
  `export_statement` that has a `from` source, in per-file source order,
  files iterated in sorted-key order. `import type` names are included.
  `{a as b}` reports `a` (the name as exported by `from`, per contract).
  `export * as ns from` reports `"*"`, same as `export * from`. Side-effect
  imports produce `names: []`. Two statements importing the same module
  produce two refs (not merged — downstream can merge on `(file, from)`).
  Relative specifiers (`./`, `../`) are resolved by pure path normalization
  against the importing file's directory — the target need not exist in
  `files` and no extension guessing happens (extension kept as written).
  Bare specifiers (`node:fs`, `react`, `#alias`) pass through unchanged.
  Not covered (out of scope): dynamic `import()`, `import x = require()`,
  `export =`.
- Worker-safe: `src/` still uses only `crypto.subtle`, `TextEncoder` and
  web-tree-sitter — no Node APIs.

Perf on the demo fixture (6 files, best-of-5, Node test runner):
`hashInterface` = 4.8 ms; `hashInterface` + `extractImports` = 5.6 ms →
1.18x, well under the ~2x budget (extractImports adds one parse + a cheap
top-level walk per file; bodyHash adds one extra canon walk + sha256 per
symbol inside hashInterface).

## Contract issues

None. The contract's `files` map (path→source) works cleanly; re-export
resolution relies only on those keys.

## Cloudflare resources created

- Worker `arb-test-hasher` (workers.dev, throwaway proof; delete after
  integration is proven or at cleanup time).
