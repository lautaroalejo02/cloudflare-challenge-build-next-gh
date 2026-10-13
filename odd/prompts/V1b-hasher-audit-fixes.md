First read `odd/prompts/_builder_head.md` completely and follow every rule in it. Also read `odd/tasks/arb-v2.md` and the "(V2)" hasher items in `app/CONTRACTS.md`. Other agents edit `app/mcp/` and `app/control-plane/` in parallel; do not touch them.

# Task V1b: Fix the audit findings in the V2 hasher (commit f01087f)

## Allowed edit surfaces
app/hasher/**

## Why it matters
The control plane will:
- call a paid LLM judge (Jev) whenever `bodyHash` changes while `hash` is unchanged, so a false `bodyHash` change on a reformat costs money and can squash a consumer for nothing;
- infer dependencies by string-comparing `ImportRef.from` to `SymbolSignature.file`, so both must use the exact same path form.

## Findings to fix (RED test first for each, then GREEN)
Line numbers refer to `app/hasher/src/index.ts`.

1. **`bodyHash` must not change on pure reformatting** (`canon`, ~117-141). Today these differ and must become equal:
   - trailing commas in object/array literals, call arguments and parameter lists;
   - single vs double quotes around the same string literal; canonicalize to the fragment text;
   - parentheses around a single arrow-function parameter: `x=>x+1` vs `(x)=>x+1`.

   A real body edit must still change it. Keep `if(a) b();` vs `if(a){ b(); }` different. Apply these rules only when `includeBodies` is set: v1 `hash` values must stay byte-identical for every existing test input.
2. **`export default <identifier>`** (~660-668): resolve the identifier through `locals` to its declaration, the same way the `export {x}` path does, so `bodyHash` and `source` reflect that declaration. Cover both a default-exported local function and a local class.
3. **Dedupe collapses symbols across files** (~699-702): key the dedupe on `name` + `signature` + `file`. Two files each exporting `function helper(): void` must both appear.
4. **Path form** (`file` ~549/698, `from` via `normalizePath` ~524 and `resolveSpecifier` ~732):
   - normalize every input key once (backslashes → `/`, strip a leading `./` or `/`, collapse `.` segments);
   - use that normalized form for both `SymbolSignature.file` and as the base for resolving `from`;
   - for `from`, if the resolved path is not a key in `files`, try the same candidate list `resolveModule` uses (`.ts`, `.tsx`, `/index.ts`, `.js`→`.ts`) and return the first that exists; otherwise return the plain resolution;
   - `..` past the root resolves to the plain clamped path, and is documented in NOTES.
5. **`export * as ns from "./n.ts"`** (~776) must yield `names: ["*"]`, via the `namespace_export` child.
6. **Overload vs implementation** with the same signature: the implementation's body must drive `bodyHash`, so an edit to the implementation changes it.
7. **Flaky perf assertion:** remove the `ratio <= 2x` hard assertion from the test suite. Keep the timing as a printed measurement only.

## Out of scope
Decorator arguments, `import x = require()`, dynamic `import()`, and surrogate-pair-safe truncation: list them as known gaps in NOTES.md.

## Tests to add
- Each pair above: equal or different, as specified.
- An explicit test that, for the demo fixture (`app/demo/fixture/`), every `extractImports(...).from` that points to a fixture file equals the `file` of the symbol it imports.
- Const initializer and default-export body changes move `bodyHash`.

## Verification
- `npm test` in `app/hasher`: ALL PASS. Paste the base hash line and confirm it is still `f9916f523525`.
- NOTES.md: a "V1b audit fixes" table with finding → fix → test name.
