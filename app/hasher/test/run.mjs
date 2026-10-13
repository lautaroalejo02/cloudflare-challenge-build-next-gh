// Node test suite for app/hasher. Loads both wasm modules from disk and calls
// initHasher() explicitly (the explicit init path; Workers use the lazy path).
// Run: node --experimental-strip-types test/run.mjs
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { initHasher, hashInterface, extractImports } from "../src/index.ts";
import { base, cases, expectSame } from "./cases.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "..");

await initHasher(
  new WebAssembly.Module(readFileSync(join(pkgDir, "src", "web-tree-sitter.wasm"))),
  new WebAssembly.Module(readFileSync(join(pkgDir, "src", "tree-sitter-typescript.wasm"))),
);

let fails = 0;
const check = (ok, label) => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
};

const results = {};
for (const [name, src] of cases) {
  results[name] = await hashInterface({ "src/order.ts": src });
}

for (const [name] of cases.slice(1)) {
  const same = results[name].hash === results.base.hash;
  const wantSame = expectSame.has(name);
  check(
    same === wantSame,
    `${name.padEnd(22)} ${same ? "same" : "diff"} (expected ${wantSame ? "same" : "diff"})`,
  );
}

// --- per-symbol hashes -------------------------------------------------------
const baseSyms = results.base.symbols;
const byName = Object.fromEntries(baseSyms.map((s) => [s.name, s]));

const wantKinds = {
  CartItem: "interface",
  Cart: "interface",
  Order: "interface",
  Region: "type",
  TAX_RATE: "const",
  createOrder: "function",
  calcTax: "function",
  OrderService: "class",
};
for (const [name, kind] of Object.entries(wantKinds)) {
  check(byName[name]?.kind === kind, `symbol ${name} kind=${byName[name]?.kind} (want ${kind})`);
}

// every symbol hash = first 12 hex of sha256(signature), computed independently
let hashOk = true;
for (const s of baseSyms) {
  const h = createHash("sha256").update(s.signature).digest("hex").slice(0, 12);
  if (h !== s.hash || s.hash.length !== 12) hashOk = false;
}
check(hashOk, "symbol hashes = sha256(signature)[0:12]");

// param-type change moves only createOrder's hash; signature text shows it
const b1Syms = Object.fromEntries(results.b1_param_type.symbols.map((s) => [s.name, s]));
check(b1Syms.createOrder.hash !== byName.createOrder.hash, "b1: createOrder hash changed");
check(
  b1Syms.Cart.hash === byName.Cart.hash && b1Syms.OrderService.hash === byName.OrderService.hash,
  "b1: untouched symbols keep their hashes",
);
check(
  byName.createOrder.signature.includes("region:Region") &&
    b1Syms.createOrder.signature.includes("region:string"),
  `b1: signatures diff (old: ${byName.createOrder.signature} | new: ${b1Syms.createOrder.signature})`,
);

// body-only changes keep every symbol hash identical
const cSyms = Object.fromEntries(results.c_body_only.symbols.map((s) => [s.name, s]));
check(
  baseSyms.every((s) => cSyms[s.name]?.hash === s.hash),
  "c_body_only: all per-symbol hashes unchanged",
);

// file path does not affect the hash
const renamed = await hashInterface({ "other/dir/x.ts": base });
check(renamed.hash === results.base.hash, "file path does not affect hash");

// multi-file aggregation + re-export resolution
const multi = await hashInterface({
  "src/api.ts": `export interface Order { id: string; }\nexport function createOrder(): Order { return { id: "x" }; }`,
  "src/index.ts": `export { createOrder } from "./api.ts";\nexport * from "./api.ts";`,
});
const multiNames = multi.symbols.map((s) => s.name).sort();
check(
  JSON.stringify(multiNames) === JSON.stringify(["Order", "createOrder"]),
  `re-exports resolve (${multiNames.join(",")})`,
);

// unexported declarations are ignored
const hidden = await hashInterface({ "x.ts": `const secret = 1;\nexport const pub = 2;` });
check(hidden.symbols.length === 1 && hidden.symbols[0].name === "pub", "only exported symbols count");

// classes: private/protected/# members are excluded from the signature
const clsPriv = await hashInterface({
  "x.ts": `export class A { private x = 1; #y = 2; protected z = 3; pub = 4; m(): number { return this.x; } }`,
});
const clsPriv2 = await hashInterface({
  "x.ts": `export class A { private x = 99; #y = 42; protected z = "changed"; pub = 4; m(): number { return 7; } }`,
});
check(clsPriv.hash === clsPriv2.hash, "private/protected/# members and method bodies ignored");

// --- V2: file / bodyHash / source ----------------------------------------------
const sym = (r, n) => r.symbols.find((s) => s.name === n);

check(sym(results.base, "createOrder").file === "src/order.ts", "V2 file: declaring path");

// body-only change: `hash` identical, `bodyHash` different
const aMap = Object.fromEntries(results["a_reformat+comments"].symbols.map((s) => [s.name, s]));
const cMap = Object.fromEntries(results.c_body_only.symbols.map((s) => [s.name, s]));
check(
  cMap.createOrder.hash === byName.createOrder.hash &&
    cMap.createOrder.bodyHash !== byName.createOrder.bodyHash &&
    cMap.OrderService.bodyHash !== byName.OrderService.bodyHash &&
    cMap.Cart.bodyHash === byName.Cart.bodyHash,
  "V2 bodyHash: body-only change moves bodyHash, not hash",
);
check(
  baseSyms.every((s) => aMap[s.name]?.bodyHash === s.bodyHash),
  "V2 bodyHash: comments/reformat leave bodyHash unchanged",
);

// source: raw declaration incl. leading `export` and the body
check(
  byName.createOrder.source.startsWith("export function createOrder(cart: Cart, region: Region): Order {") &&
    byName.createOrder.source.includes("total * (1 + TAX_RATE)"),
  "V2 source: raw declaration incl. export keyword + body",
);

// source: truncated to 4000 chars
const bigSrc = `export function big(): number {\n${"  const x = 123456789 + 987654321;\n".repeat(300)}  return x;\n}`;
const big = await hashInterface({ "big.ts": bigSrc });
check(
  big.symbols[0].source.length === 4000 && big.symbols[0].source === bigSrc.slice(0, 4000),
  `V2 source: truncated to 4000 chars (${big.symbols[0].source.length})`,
);

// source: directly attached JSDoc included; blank-line-separated comment excluded
const doc = await hashInterface({
  "d.ts": "/** Adds two numbers. */\nexport function add(a: number, b: number): number { return a + b; }",
});
check(doc.symbols[0].source.startsWith("/** Adds two numbers. */\nexport"), "V2 source: attached JSDoc included");
const noDoc = await hashInterface({
  "d.ts": "// stray comment\n\nexport function sub(): number { return 0; }",
});
check(!noDoc.symbols[0].source.includes("stray"), "V2 source: detached comment excluded");

// file: re-exported symbol reports the declaring file, not the re-exporting one
check(sym(multi, "createOrder").file === "src/api.ts", "V2 file: re-export resolves to declaring file");

// --- V2: extractImports ----------------------------------------------------------
const imps = await extractImports({
  "src/ui/checkout.ts": `import { createOrder } from "../api/order.ts";
import type { Cart } from "../api/order.ts";
import def, { thing as t } from "./util.ts";
import * as ns from "../../shared.ts";
import "./side.ts";
import fs from "node:fs";
import react from "react";
export { X } from "../x.ts";
export * from "../all.ts";
`,
});
const names = (file, from) => imps.find((i) => i.file === file && i.from === from)?.names ?? null;
check(
  imps.some((i) => i.file === "src/ui/checkout.ts" && i.from === "src/api/order.ts" && i.names.includes("createOrder")),
  "V2 imports: { createOrder } from ../api/order.ts -> src/api/order.ts",
);
check(
  imps.some((i) => i.file === "src/ui/checkout.ts" && i.from === "src/api/order.ts" && i.names.includes("Cart")),
  "V2 imports: import type names included",
);
check(
  JSON.stringify(names("src/ui/checkout.ts", "src/ui/util.ts")) === JSON.stringify(["default", "thing"]),
  "V2 imports: default binding + alias keeps original name",
);
check(
  JSON.stringify(names("src/ui/checkout.ts", "shared.ts")) === JSON.stringify(["*"]),
  "V2 imports: namespace import + ../.. resolution",
);
check(
  JSON.stringify(names("src/ui/checkout.ts", "src/ui/side.ts")) === JSON.stringify([]),
  "V2 imports: side-effect import -> names []",
);
check(
  JSON.stringify(names("src/ui/checkout.ts", "node:fs")) === JSON.stringify(["default"]),
  "V2 imports: bare specifier kept as written",
);
check(names("src/ui/checkout.ts", "react")?.includes("default") ?? false, "V2 imports: bare package kept as written");
check(
  JSON.stringify(names("src/ui/checkout.ts", "src/x.ts")) === JSON.stringify(["X"]),
  "V2 imports: export { X } from counts as import",
);
check(
  JSON.stringify(names("src/ui/checkout.ts", "src/all.ts")) === JSON.stringify(["*"]),
  "V2 imports: export * from gives *",
);

// real fixture: src/ui/checkout.ts imports createOrder from src/api/order.ts
const fixtureDir = join(pkgDir, "..", "demo", "fixture");
const fixtureFiles = {};
for (const rel of [
  "src/api/order.ts",
  "src/api/payment.ts",
  "src/ui/checkout.ts",
  "src/ui/paywall.ts",
  "tests/order.test.ts",
  "tests/payment.test.ts",
]) {
  fixtureFiles[rel] = readFileSync(join(fixtureDir, rel), "utf8");
}
const fixImps = await extractImports(fixtureFiles);
check(
  fixImps.some((i) => i.file === "src/ui/checkout.ts" && i.from === "src/api/order.ts" && i.names.includes("createOrder")),
  "V2 imports: fixture checkout.ts -> src/api/order.ts createOrder",
);

// perf: hashInterface + extractImports must stay under ~2x hashInterface alone
const bench = async (fn, n = 5) => {
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await fn();
    const d = performance.now() - t;
    if (d < best) best = d;
  }
  return best;
};
const tHash = await bench(() => hashInterface(fixtureFiles));
const tBoth = await bench(async () => {
  await hashInterface(fixtureFiles);
  await extractImports(fixtureFiles);
});
console.log(
  `perf: hashInterface=${tHash.toFixed(1)}ms  hash+imports=${tBoth.toFixed(1)}ms  ratio=${(tBoth / tHash).toFixed(2)}x`,
);
check(tBoth <= 2 * tHash, `V2 perf: combined <= 2x hashInterface (${(tBoth / tHash).toFixed(2)}x)`);

console.log(`base hash: ${results.base.hash}`);
console.log(`base symbols: ${baseSyms.map((s) => `${s.name}#${s.hash}`).join(" ")}`);
console.log(fails === 0 ? "ALL PASS" : `${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
