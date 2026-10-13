First read `odd/prompts/_builder_head.md` completely and follow every rule in it. Also read `odd/tasks/arb-v2.md`. Then do the task below. Other agents work in parallel on `app/mcp/`, `app/control-plane/` and `app/dashboard/`; do not touch them.

# Task V1: Hasher — imports, declaring file, body hash, source

## Allowed edit surfaces
app/hasher/**

## Contract
Implement exactly the "(V2)" additions in `app/CONTRACTS.md` under "`app/hasher` exports":
- `SymbolSignature` gains `file`, `bodyHash`, `source`. Existing `hash` values and the overall `InterfaceHash.hash` must NOT change for any existing input: every existing test stays green unmodified.
- New `extractImports(files): Promise<ImportRef[]>`.

## Requirements
1. **bodyHash.** 12 hex of sha256 over the normalized full declaration, including function bodies, const initializers and class member bodies. Use the same normalization as `hash`: comments and formatting do not change it. A changed body or initializer changes it. A reformat or a comment change does not.
2. **source.** The raw declaration text as written in the file, truncated to 4000 chars. Include a leading `export` keyword and any JSDoc directly attached.
3. **file.** The repo-relative path key from the `files` input.
4. **extractImports.** Use the same tree-sitter parse, not regexes. Cover:
   - named, aliased (`{ a as b }` gives name `a`), default (`"default"`), namespace (`"*"`);
   - `import type`;
   - side-effect imports (`names: []`);
   - `export { x } from` and `export * from` (`"*"`).
   Resolve relative specifiers against the importing file's directory to a normalized repo-relative path with POSIX separators. Keep the extension as written. Keep bare specifiers (`"node:fs"`, `"react"`) unchanged.
5. It must still run inside a Worker: no Node-only APIs in `src/`.
6. Performance: on the demo fixture (`app/demo/fixture/`), `hashInterface` + `extractImports` together must stay under about 2x the current `hashInterface` time. Report both numbers.

## Tests (RED first)
Add tests for:
- body change: `hash` equal, `bodyHash` different;
- comment or reformat: both equal;
- `source` content and truncation;
- every import form above;
- path resolution with `../` and `./`;
- the real fixture files: `src/ui/checkout.ts` imports `createOrder` from `src/api/order.ts`.

## Verification
- `npm test` in `app/hasher`: all green. Paste the pass/fail counts.
- Record decisions and timings in `app/hasher/NOTES.md` under "V2".
