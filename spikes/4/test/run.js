const { writeFileSync, mkdirSync, readFileSync } = require("fs");
const { join, resolve } = require("path");
const { spawnSync, execFileSync } = require("child_process");
const { hashFile } = require("../bin/hash-interface.js");

const dir = resolve(__dirname, "..", "tmp", "cases");
mkdirSync(dir, { recursive: true });

const base = readFileSync(resolve(__dirname, "..", "fixture", "order.ts"), "utf8");
writeFileSync(join(dir, "base.ts"), base);

// (a) same signatures, wild reformatting + comments everywhere
const a_reformat = `// leading comment
export   interface   CartItem{sku:string
qty:number}
export interface Cart{
  items:CartItem[];currency:string // trailing
}
/** doc comment */ export interface Order{id:string;total:number;region:string}
export type Region=
"us"|"eu"|"apac"; // reformatted union
export const TAX_RATE=0.2;
export function createOrder(
cart:Cart, /* inline */ region:Region
):Order{
const total=cart.items.reduce((acc,i)=>acc+i.qty,0);return{id:\`\${region}-\${total}\`,total:total*(1+TAX_RATE),region};}
export const calcTax=(amount:number,rate?:number):number=>amount*(rate??TAX_RATE);
export class OrderService{private repo="memory";
constructor(private prefix:string){}static of(prefix:string):OrderService{return new OrderService(prefix);}
submit(cart:Cart,region:Region):Order{const o=createOrder(cart,region);return{...o,id:\`\${this.prefix}:\${o.id}\`};}}
`;

// (c) same signatures, different function bodies
const c_body = base
  .replace(
    /export function createOrder\(cart: Cart, region: Region\): Order \{[\s\S]*?\n\}/,
    `export function createOrder(cart: Cart, region: Region): Order {
  let total = 0;
  for (const i of cart.items) total += i.qty; // different impl
  const id = region + "/" + String(total);
  return { id, total: total + total * TAX_RATE, region };
}`
  )
  .replace(
    "return new OrderService(prefix);",
    "const s = new OrderService(prefix); return s;"
  );

// (b1) param type change
const b1_paramtype = base.replace("region: Region): Order", "region: string): Order");
// (b2) added param
const b2_addparam = base.replace(
  "cart: Cart, region: Region): Order",
  "cart: Cart, region: Region, strict?: boolean): Order"
);

// (d1) reorder exported declarations
const d1_reorder = [
  `export class OrderService {
  private repo = "memory";
  constructor(private prefix: string) {}
  static of(prefix: string): OrderService {
    return new OrderService(prefix);
  }
  submit(cart: Cart, region: Region): Order {
    const o = createOrder(cart, region);
    return { ...o, id: \`\${this.prefix}:\${o.id}\` };
  }
}`,
  `export type Region = "us" | "eu" | "apac";`,
  `export const TAX_RATE = 0.2;`,
  `export const calcTax = (amount: number, rate?: number): number =>
  amount * (rate ?? TAX_RATE);`,
  `export interface CartItem {
  sku: string;
  qty: number;
}`,
  `export interface Cart {
  items: CartItem[];
  currency: string;
}`,
  `export interface Order {
  id: string;
  total: number;
  region: string;
}`,
  `export function createOrder(cart: Cart, region: Region): Order {
  const total = cart.items.reduce((acc, i) => acc + i.qty, 0);
  return { id: \`\${region}-\${total}\`, total: total * (1 + TAX_RATE), region };
}`,
].join("\n");

// (d2) return type change
const d2_ret = base.replace("region: Region): Order {", "region: Region): string {");
// (d3) interface field change
const d3_iface = base.replace("  total: number;", "  total: string;");

const cases = [
  ["base", base],
  ["a_reformat+comments", a_reformat],
  ["b1_param_type", b1_paramtype],
  ["b2_add_param", b2_addparam],
  ["c_body_only", c_body],
  ["d1_reorder_decls", d1_reorder],
  ["d2_return_type", d2_ret],
  ["d3_iface_field", d3_iface],
];

const expectSame = new Set(["a_reformat+comments", "c_body_only", "d1_reorder_decls"]);
const expectDiff = new Set(["b1_param_type", "b2_add_param", "d2_return_type", "d3_iface_field"]);

const hashes = {};
let fails = 0;
for (const [name, src] of cases) {
  const p = join(dir, name + ".ts");
  writeFileSync(p, src);
  hashes[name] = hashFile(p);
}
for (const name of Object.keys(hashes)) {
  if (name === "base") continue;
  const same = hashes[name] === hashes.base;
  const wantSame = expectSame.has(name);
  const ok = same === wantSame;
  if (!ok) fails++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name.padEnd(22)} ${same ? "same" : "diff"} (expected ${wantSame ? "same" : "diff"})`
  );
}

// prove the real CLI works end-to-end via npx
const npx = spawnSync("npx hash-interface tmp/cases/base.ts", {
  shell: true,
  cwd: resolve(__dirname, ".."),
  encoding: "utf8",
});
const cliHash = (npx.stdout || "").trim();
const cliOk = npx.status === 0 && cliHash === hashes.base;
if (!cliOk) fails++;
console.log(`${cliOk ? "PASS" : "FAIL"} npx hash-interface   -> ${cliHash || npx.stderr}`);

// cold-process timing: fresh node each time (median of 7)
const binPath = resolve(__dirname, "..", "bin", "hash-interface.js");
const basePath = join(dir, "base.ts");
const cold = [];
for (let i = 0; i < 7; i++) {
  const t = process.hrtime.bigint();
  execFileSync("node", [binPath, basePath]);
  cold.push(Number(process.hrtime.bigint() - t) / 1e6);
}
cold.sort((a, b) => a - b);

// in-process timing: first call (checker warm-up) then mean of 200
const t0 = process.hrtime.bigint();
hashFile(basePath);
const firstMs = Number(process.hrtime.bigint() - t0) / 1e6;
for (let i = 0; i < 20; i++) hashFile(basePath);
const t1 = process.hrtime.bigint();
for (let i = 0; i < 200; i++) hashFile(basePath);
const meanMs = Number(process.hrtime.bigint() - t1) / 1e6 / 200;

console.log(`base sha256: ${hashes.base}`);
console.log(`cold process (node bin, incl. startup): median ${cold[3].toFixed(1)}ms, min ${cold[0].toFixed(1)}ms, max ${cold[6].toFixed(1)}ms`);
console.log(`in-process: first call ${firstMs.toFixed(1)}ms (new Project+checker), steady-state mean ${meanMs.toFixed(2)}ms over 200 iters`);
console.log(fails === 0 ? "ALL PASS" : `${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
