# spike-4 — ts-morph exported-interface signature hash (`hash-interface <file>`)

Question: extract all exported function/type/interface signatures (+ exported const arrow fns, class public members), normalize (no comments/formatting, stable order), sha256 → CLI `hash-interface`.

Verdict: WORKS

## Measured (Node v22.15.1, Windows 11, fixture/order.ts ~40 lines, 10 exported decls)
- All 7 mutation cases PASS via `npm test` (spawns CLI + in-process): (a) reformat+comments → same; (b) param-type change & added param → diff; (c) body-only change → same; (d) decl reorder → same, return-type & interface-field change → diff. Hash: `90761e25…3c79b`.
- Cold process (`node bin/hash-interface.js`, includes node startup+ts-morph require): median 755ms, min 546ms (n=7). `npx hash-interface` verified working (adds ~300-500ms npx overhead, not separately timed).
- In-process per hash: first call 15.3ms, steady-state mean 8.77ms (n=200), new `Project` each call with `skipLoadingLibFiles:true`. WITHOUT that flag: 265ms/hash (lib.*.d.ts load dominates, not the checker).

## Repro
```
cd spikes/4 && npm i   # ts-morph@^27 (bundles TS 5.9.2)
npx hash-interface fixture/order.ts          # prints sha256
npm test                                    # PASS/FAIL per case + timings
```
Mechanism (`bin/hash-interface.js`): `Project.createSourceFile` (skip tsconfig/deps/libs), `sf.getExportedDeclarations()` → per-node canonical sig string. Type/member text via `ts.createPrinter({removeComments:true}).printNode` (canonicalizes formatting+comments); fn sigs rebuilt manually (name/typeParams/params/return, bodies ignored); classes emit public ctor/method/property sigs only. All sigs sorted, joined, sha256.

## Caveats
- Covers exported decls incl. `export {x}` specifiers and `export default` via `getExportedDeclarations`; `export *` re-exports resolve to declarations in other files (untested).
- Without lib files, inferred types of unannotated nodes degrade for non-primitives (`f(x)=>x` → `any`); annotated signatures unaffected. `const TAX_RATE=0.2` still infers literal `0.2` (value change = hash change — intended).
- Function overloads: each overload sig hashed (untested). Private `#x`/private/protected class members excluded.
- Comments inside string-literal types are safe (printer, not regex).

## Cloudflare resources created
None.

## Recommendation
Use this approach: ~9ms/hash in-process, ~750ms cold CLI — plenty fast; keep `skipLoadingLibFiles:true` + printer-based normalization.
