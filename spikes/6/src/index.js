import { Parser, Language } from "web-tree-sitter";
import runtimeWasm from "./web-tree-sitter.wasm";
import langWasm from "./tree-sitter-typescript.wasm";

let initPromise = null;
let initMs = null;

function getParser() {
  initPromise ??= (async () => {
    const t0 = Date.now();
    await Parser.init({
      instantiateWasm: (imports, cb) => {
        WebAssembly.instantiate(runtimeWasm, imports).then((inst) =>
          cb(inst, runtimeWasm),
        );
      },
    });
    const lang = Language.loadSync(langWasm);
    const parser = new Parser();
    parser.setLanguage(lang);
    await new Promise((r) => setTimeout(r, 1));
    initMs = Date.now() - t0 - 1;
    return parser;
  })();
  return initPromise;
}

const FN_TYPES = new Set([
  "function_declaration",
  "generator_function_declaration",
  "function_signature",
]);

function findFn(node, depth) {
  if (FN_TYPES.has(node.type)) return node;
  if (depth <= 0) return null;
  for (const c of node.children) {
    const hit = findFn(c, depth - 1);
    if (hit) return hit;
  }
  return null;
}

function exportedFunctions(root) {
  const out = [];
  for (const node of root.children) {
    if (node.type !== "export_statement") continue;
    const fn = findFn(node, 4);
    if (!fn) continue;
    const name = fn.childForFieldName("name");
    const params = fn.childForFieldName("parameters");
    out.push({
      name: name ? name.text : "<anonymous>",
      params: params ? params.text : "()",
    });
  }
  return out;
}

export default {
  async fetch(request) {
    const cold = initPromise === null;
    const t0 = performance.now();
    const parser = await getParser();
    const readyMs = performance.now() - t0;
    const source = await request.text();
    // Timers are frozen during sync execution; measure N parses across an
    // await boundary where the clock advances.
    const t1 = Date.now();
    let tree;
    for (let i = 0; i < 5; i++) tree = parser.parse(source);
    await new Promise((r) => setTimeout(r, 1));
    const parseMs = (Date.now() - t1) / 5;
    const functions = exportedFunctions(tree.rootNode);
    return Response.json({
      cold,
      initMs: cold ? initMs : 0,
      readyMs,
      parseMs,
      sourceBytes: source.length,
      functions,
    });
  },
};
