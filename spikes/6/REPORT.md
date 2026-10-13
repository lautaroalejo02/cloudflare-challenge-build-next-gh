# spike-6: web-tree-sitter (WASM) + TypeScript grammar inside a Cloudflare Worker

Verdict: **WORKS WITH CAVEATS** — parses POSTed TS and returns exported fn names + params (verified: function/async/generator/`export default`/`declare function`).

## Measured numbers (real deploy, workers.dev, curl e2e + `wrangler tail --format json` cpuTime)
- Bundle: **2652.88 KiB upload / 329.33 KiB gzip** (runtime wasm 210KB + grammar wasm 2.34MB) vs **64 MiB** Paid limit — fits easily.
- In-Worker cpuTime (`tail` JSON): 413B file, 5 parses + extract + JSON = **28–64 ms/req**; 233KB file (2000 exports) = **542–822 ms/req** → ~110–160 ms/parse (~1.5–2 MB/s).
- E2E 10 reqs, 413B: warm ~105–125 ms, cold ~136–240 ms → cold overhead ≈ **30–120 ms** (isolate boot + init; most sequential requests hit fresh isolates). First post-deploy req: 1.17 s (propagation). Big file e2e: 0.78–1.22 s.
- In-Worker `Date.now()/performance.now()` are frozen during sync execution (measured: 233KB parse reports 0.0 ms) — even across `setTimeout(1)`. Use tail cpuTime/wallTime. Exact Parser.init ms: NOT MEASURED (bounded by cold-e2e delta ≈ tens of ms).

## Repro
`wrangler.toml`: `rules=[{type="CompiledWasm",globs=["**/*.wasm"]}]`. Worker: `import rt from "./web-tree-sitter.wasm"`; `await Parser.init({instantiateWasm:(i,cb)=>WebAssembly.instantiate(rt,i).then(x=>cb(x,rt))})`; `Language.loadSync(grammarModule)`; `parser.parse(src)`; walk `export_statement` → `function_declaration`/`function_signature` name+parameters fields. `npx wrangler deploy`.

## Caveats / required workarounds
1. **`tree-sitter-wasms` grammar has legacy `dylink` section, not `dylink.0`** → `Language.loadSync` throws "need dylink section". Workaround: rewrote the custom section in the wasm binary to `dylink.0` with a MEM_INFO subsection (same values; ~20-line Node script). Alternative: rebuild grammar via `tree-sitter build --wasm` (emscripten).
2. Dynamic compile is banned: `new WebAssembly.Module(bytes)`/`compileStreaming` disallowed → must import `.wasm` as CompiledWasm module + `instantiateWasm` hook; `Language.load(bytes|url)` unusable.
3. Emscripten fs/fetch paths never hit once `instantiateWasm` is supplied. No eval/`__em_js__` in this grammar — OK.

## Cloudflare resources created
- Worker: `spike-6-tree-sitter` (workers.dev enabled)

## Recommendation
Use it — but build the grammar with `tree-sitter build --wasm` at build time (proper `dylink.0`) instead of patching binaries, and measure via tail cpuTime, not in-Worker timers.
