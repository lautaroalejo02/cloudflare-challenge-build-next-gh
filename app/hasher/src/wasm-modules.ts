// Worker-only lazy-init path: inside a Worker bundle built with
// `rules = [{ type = "CompiledWasm", globs = ["**/*.wasm"] }]`, .wasm imports
// resolve to WebAssembly.Module objects (no fetch, no compile — dynamic
// compilation is banned in Workers). Never imported at module load time;
// index.ts dynamic-imports this file only when initHasher() was not called.
import runtimeWasm from "./web-tree-sitter.wasm";
import grammarWasm from "./tree-sitter-typescript.wasm";

export { runtimeWasm, grammarWasm };
