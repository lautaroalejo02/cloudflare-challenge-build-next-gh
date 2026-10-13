// Shared test fixtures (spike-4 cases ported verbatim). Imported by the Node
// suite (run.mjs) and by gen-payloads.mjs which serializes the same inputs for
// the deployed proof Worker.

export const base = `export interface CartItem {
  sku: string;
  qty: number;
}

export interface Cart {
  items: CartItem[];
  currency: string;
}

export interface Order {
  id: string;
  total: number;
  region: string;
}

export type Region = "us" | "eu" | "apac";

export const TAX_RATE = 0.2;

export function createOrder(cart: Cart, region: Region): Order {
  const total = cart.items.reduce((acc, i) => acc + i.qty, 0);
  return { id: \`\${region}-\${total}\`, total: total * (1 + TAX_RATE), region };
}

export const calcTax = (amount: number, rate?: number): number =>
  amount * (rate ?? TAX_RATE);

export class OrderService {
  private repo = "memory";
  constructor(private prefix: string) {}
  static of(prefix: string): OrderService {
    return new OrderService(prefix);
  }
  submit(cart: Cart, region: Region): Order {
    const o = createOrder(cart, region);
    return { ...o, id: \`\${this.prefix}:\${o.id}\` };
  }
}
`;

// (a) same signatures, wild reformatting + comments everywhere
export const a_reformat = `// leading comment
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
export const c_body = base
  .replace(
    /export function createOrder\(cart: Cart, region: Region\): Order \{[\s\S]*?\n\}/,
    `export function createOrder(cart: Cart, region: Region): Order {
  let total = 0;
  for (const i of cart.items) total += i.qty; // different impl
  const id = region + "/" + String(total);
  return { id, total: total + total * TAX_RATE, region };
}`,
  )
  .replace(
    "return new OrderService(prefix);",
    "const s = new OrderService(prefix); return s;",
  );

// (b1) param type change
export const b1_paramtype = base.replace("region: Region): Order", "region: string): Order");
// (b2) added param
export const b2_addparam = base.replace(
  "cart: Cart, region: Region): Order",
  "cart: Cart, region: Region, strict?: boolean): Order",
);

// (d1) reorder exported declarations
export const d1_reorder = [
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
export const d2_ret = base.replace("region: Region): Order {", "region: Region): string {");
// (d3) interface field change
export const d3_iface = base.replace("  total: number;", "  total: string;");
// extra: private class member change must not move the hash
export const priv = base.replace('private repo = "memory"', 'private repo = "postgres"');

export const cases = [
  ["base", base],
  ["a_reformat+comments", a_reformat],
  ["b1_param_type", b1_paramtype],
  ["b2_add_param", b2_addparam],
  ["c_body_only", c_body],
  ["d1_reorder_decls", d1_reorder],
  ["d2_return_type", d2_ret],
  ["d3_iface_field", d3_iface],
  ["private_member", priv],
];

export const expectSame = new Set(["a_reformat+comments", "c_body_only", "d1_reorder_decls", "private_member"]);
export const expectDiff = new Set(["b1_param_type", "b2_add_param", "d2_return_type", "d3_iface_field"]);
