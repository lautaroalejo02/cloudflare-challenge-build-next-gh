// Node test suite for app/hasher. Loads both wasm modules from disk and calls
// initHasher() explicitly (the explicit init path; Workers use the lazy path).
// Run: node --experimental-strip-types test/run.mjs
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { initHasher, hashInterface } from "../src/index.ts";
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

console.log(`base hash: ${results.base.hash}`);
console.log(`base symbols: ${baseSyms.map((s) => `${s.name}#${s.hash}`).join(" ")}`);
console.log(fails === 0 ? "ALL PASS" : `${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
