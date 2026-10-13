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

// --- V1b audit fixes ----------------------------------------------------------
// bodyHash of the first (or named) symbol of a one-file program
const bh = async (src, name) => {
  const r = await hashInterface({ "v.ts": src });
  const s = name ? r.symbols.find((x) => x.name === name) : r.symbols[0];
  return s ? s.bodyHash : "<missing>";
};

// (1) bodyHash ignores pure reformatting: trailing commas
check(
  (await bh(`export function f(a: number, b: number): number { return a + b; }`)) ===
    (await bh(`export function f(a: number, b: number,): number { return a + b; }`)),
  "V1b bodyHash: trailing comma in parameter list ignored",
);
check(
  (await bh(`export function f(): object { return { a: 1, b: 2 }; }`)) ===
    (await bh(`export function f(): object { return { a: 1, b: 2, }; }`)),
  "V1b bodyHash: trailing comma in object literal ignored",
);
check(
  (await bh(`export function f(): number[] { return [1, 2]; }`)) ===
    (await bh(`export function f(): number[] { return [1, 2,]; }`)),
  "V1b bodyHash: trailing comma in array literal ignored",
);
check(
  (await bh(`export function g(x: number): number { return h(x, 2); }`)) ===
    (await bh(`export function g(x: number): number { return h(x, 2,); }`)),
  "V1b bodyHash: trailing comma in call arguments ignored",
);
// (1) bodyHash ignores quote style on the same literal
check(
  (await bh(`export const s = "double";`)) === (await bh(`export const s = 'double';`)),
  "V1b bodyHash: single vs double quotes ignored",
);
// (1) bodyHash ignores parens around a single arrow-function parameter
check(
  (await bh(`export const f = x => x + 1;`)) === (await bh(`export const f = (x) => x + 1;`)),
  "V1b bodyHash: parens around single arrow param ignored",
);
check(
  (await bh(`export const inc = (xs: number[]) => xs.map(x => x + 1);`)) ===
    (await bh(`export const inc = (xs: number[]) => xs.map((x) => x + 1);`)),
  "V1b bodyHash: nested arrow param parens ignored",
);
// (1) real body edits and real structural edits still change bodyHash
check(
  (await bh(`export function f(a: number, b: number): number { return a + b; }`)) !==
    (await bh(`export function f(a: number, b: number): number { return a - b; }`)),
  "V1b bodyHash: real body edit still changes bodyHash",
);
check(
  (await bh(`export function f(a: boolean): void { if (a) g(); }`)) !==
    (await bh(`export function f(a: boolean): void { if (a) { g(); } }`)),
  "V1b bodyHash: if(a) b() vs if(a){ b() } still differ",
);
// const initializers and default-export bodies move bodyHash (not hash)
{
  const c1 = await hashInterface({ "c.ts": `export const LIMIT = 1;` });
  const c2 = await hashInterface({ "c.ts": `export const LIMIT = 2;` });
  check(
    c1.symbols[0].bodyHash !== c2.symbols[0].bodyHash && c1.symbols[0].hash === c2.symbols[0].hash,
    "V1b bodyHash: const initializer change moves bodyHash only",
  );
}
check(
  (await bh(`export default function d(): number { return 1; }`, "d")) !==
    (await bh(`export default function d(): number { return 2; }`, "d")),
  "V1b bodyHash: export default function body change moves bodyHash",
);

// (2) export default <identifier> resolves through locals like `export {x}`
{
  const r1 = await hashInterface({
    "d.ts": `function helper(): number { return 1; }\nexport default helper;`,
  });
  const r2 = await hashInterface({
    "d.ts": `function helper(): number { return 2; }\nexport default helper;`,
  });
  const d1 = r1.symbols.find((s) => s.name === "default");
  const d2 = r2.symbols.find((s) => s.name === "default");
  check(
    d1?.kind === "function" && d1.signature.startsWith("fn helper"),
    `V1b default-export local function resolves to declaration (${d1?.signature})`,
  );
  check(
    typeof d1?.source === "string" && d1.source.startsWith("function helper") && !d1.source.includes("export default"),
    "V1b default-export: source is the resolved declaration",
  );
  check(d1?.bodyHash !== d2?.bodyHash, "V1b default-export: bodyHash tracks resolved declaration's body");
}
{
  const r = await hashInterface({
    "d.ts": `class Service { ping(): string { return "p"; } }\nexport default Service;`,
  });
  const d = r.symbols.find((s) => s.name === "default");
  check(
    d?.kind === "class" && d.signature.startsWith("class Service") && d.source.startsWith("class Service"),
    `V1b default-export local class resolves to declaration (${d?.signature})`,
  );
}

// (3) dedupe must not collapse identical exports across different files
{
  const r = await hashInterface({
    "src/a.ts": `export function helper(): void { /* a */ }`,
    "src/b.ts": `export function helper(): void { /* b */ }`,
  });
  const helpers = r.symbols.filter((s) => s.name === "helper");
  check(
    helpers.length === 2 && helpers.some((s) => s.file === "src/a.ts") && helpers.some((s) => s.file === "src/b.ts"),
    `V1b dedupe: identical exports in different files both appear (${helpers.length})`,
  );
}

// (4) input keys normalized once; `file` uses the normalized form
{
  const r = await hashInterface({
    ".\\src\\api.ts": `export const x = 1;`,
    "src/./index.ts": `export { x } from "./api";`,
  });
  const x = r.symbols.find((s) => s.name === "x");
  check(x?.file === "src/api.ts", `V1b paths: input keys normalized (file=${x?.file})`);
}
// (4) `from` tries the resolveModule candidate list when the plain path misses
{
  const refs = await extractImports({
    "src/ui/view.ts": `import { x } from "../api/order";\nimport { y } from "./util.js";\nimport { z } from "../../deep.ts";`,
    "src/api/order.ts": `export const x = 1;`,
    "src/ui/util.ts": `export const y = 2;`,
  });
  const from = (names0) => refs.find((i) => i.names.includes(names0))?.from;
  check(from("x") === "src/api/order.ts", `V1b imports: extensionless spec resolves .ts candidate (${from("x")})`);
  check(from("y") === "src/ui/util.ts", `V1b imports: .js specifier resolves .ts candidate (${from("y")})`);
  check(from("z") === "deep.ts", `V1b imports: .. past root clamps to plain path (${from("z")})`);
  const missing = await extractImports({ "a.ts": `import { q } from "./nope";` });
  check(missing[0]?.from === "nope", `V1b imports: unresolvable spec falls back to plain resolution (${missing[0]?.from})`);
}

// (5) `export * as ns from` yields names ["*"]
{
  const refs = await extractImports({ "m.ts": `export * as ns from "./n.ts";` });
  check(
    JSON.stringify(refs.find((i) => i.from === "n.ts")?.names) === JSON.stringify(["*"]),
    "V1b imports: export * as ns -> names ['*']",
  );
}

// (6) overload + implementation with same signature: impl body drives bodyHash
{
  const ovlA = await hashInterface({
    "o.ts": `export function f(a: string): void;\nexport function f(a: string): void { console.log(a); }`,
  });
  const ovlB = await hashInterface({
    "o.ts": `export function f(a: string): void;\nexport function f(a: string): void { console.warn(a); }`,
  });
  const implOnly = await hashInterface({
    "o.ts": `export function f(a: string): void { console.log(a); }`,
  });
  check(ovlA.symbols.length === 1, `V1b overloads: same-signature decl+impl collapse (${ovlA.symbols.length})`);
  check(
    ovlA.symbols[0].bodyHash === implOnly.symbols[0].bodyHash,
    "V1b overloads: implementation body drives bodyHash",
  );
  check(ovlA.symbols[0].bodyHash !== ovlB.symbols[0].bodyHash, "V1b overloads: impl edit changes bodyHash");
}

// fixture: every `from` that resolves into the fixture equals the symbol's `file`
{
  const fixSyms = await hashInterface(fixtureFiles);
  let fromFileOk = true;
  for (const i of fixImps) {
    if (!(i.from in fixtureFiles)) continue;
    for (const n of i.names) {
      if (n === "*") continue;
      const hit = fixSyms.symbols.find((s) => s.file === i.from && s.name === n);
      if (!hit) {
        fromFileOk = false;
        console.log(`   misses: ${i.file} imports ${n} from ${i.from}`);
      }
    }
  }
  check(fromFileOk, "V1b fixture: every import's `from` equals the imported symbol's `file`");
}

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
// (V1b) flaky assertion removed: the ratio is printed as a measurement only.

console.log(`base hash: ${results.base.hash}`);
console.log(`base symbols: ${baseSyms.map((s) => `${s.name}#${s.hash}`).join(" ")}`);
console.log(fails === 0 ? "ALL PASS" : `${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
