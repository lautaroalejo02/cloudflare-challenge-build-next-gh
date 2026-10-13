import fs from "node:fs";
import path from "node:path";
import type { ApiClient } from "../lib/http.ts";
import type { Log } from "../lib/types.ts";
import { startAgent, type AgentHandle, type Step } from "./base.ts";

// Declared stub (T11 value prediction): the API agent commits to these
// signatures at registration, before writing anything. Consumers registering
// while `predicted` is non-empty forward against the stub hashes — squashed
// only if the first real push diverges.
export const ORDER_STUB = `export interface LineItem {
  sku: string;
  qty: number;
  unitPrice: number;
}

export interface Cart {
  items: LineItem[];
}

export interface Order {
  id: string;
  region: string;
  itemCount: number;
  totalCents: number;
}

export function createOrder(cart: Cart, region: string): Order {
  throw new Error("declared stub: implementation pending");
}
`;

// First real push after the stub: the createOrder signature lands exactly as
// declared (prediction hit) but Order gains a `currency` field the stub did
// not declare (prediction miss for Order consumers).
export const ORDER_V1_1 = `export interface LineItem {
  sku: string;
  qty: number;
  unitPrice: number;
}

export interface Cart {
  items: LineItem[];
}

export interface Order {
  id: string;
  region: string;
  currency: string;
  itemCount: number;
  totalCents: number;
}

function sumCart(cart: Cart): { totalCents: number; itemCount: number } {
  let totalCents = 0;
  let itemCount = 0;
  for (const item of cart.items) {
    totalCents += item.qty * item.unitPrice;
    itemCount += item.qty;
  }
  return { totalCents, itemCount };
}

export function createOrder(cart: Cart, region: string): Order {
  const { totalCents, itemCount } = sumCart(cart);
  return { id: \`ord-\${itemCount}-\${totalCents}\`, region, currency: "USD", itemCount, totalCents };
}
`;

// Body-only refactor of ORDER_V1_1: identical exported interface (Order keeps
// `currency`, createOrder keeps the v1 signature), so this push must produce
// an early cutoff — no consumed symbol hash changes. This is the middle push
// of the live scenario: stub resolution -> body-only cutoff -> breaking change.
export const ORDER_V1_1_REFACTORED = `export interface LineItem {
  sku: string;
  qty: number;
  unitPrice: number;
}

export interface Cart {
  items: LineItem[];
}

export interface Order {
  id: string;
  region: string;
  currency: string;
  itemCount: number;
  totalCents: number;
}

function sumCart(cart: Cart): { totalCents: number; itemCount: number } {
  return cart.items.reduce(
    (acc, item) => ({
      totalCents: acc.totalCents + item.qty * item.unitPrice,
      itemCount: acc.itemCount + item.qty,
    }),
    { totalCents: 0, itemCount: 0 },
  );
}

export function createOrder(cart: Cart, region: string): Order {
  const { totalCents, itemCount } = sumCart(cart);
  const id = \`ord-\${itemCount}-\${totalCents}\`;
  return { id, region, currency: "USD", itemCount, totalCents };
}
`;

// (V2) Behavior change with the SAME signatures as ORDER_V1_1_REFACTORED: the
// interface hash is unchanged (early cutoff), but createOrder's body now adds
// 20% VAT to every total. Consumers that print or assert totals silently
// break — the case TypeSafe Jev judges and squashes as `behavior-changed`.
// The VAT math lives inside createOrder's own declaration because Jev only
// sees that declaration's source, not the rest of the module.
export const ORDER_V1_1_VAT = `export interface LineItem {
  sku: string;
  qty: number;
  unitPrice: number;
}

export interface Cart {
  items: LineItem[];
}

export interface Order {
  id: string;
  region: string;
  currency: string;
  itemCount: number;
  totalCents: number;
}

function sumCart(cart: Cart): { totalCents: number; itemCount: number } {
  return cart.items.reduce(
    (acc, item) => ({
      totalCents: acc.totalCents + item.qty * item.unitPrice,
      itemCount: acc.itemCount + item.qty,
    }),
    { totalCents: 0, itemCount: 0 },
  );
}

export function createOrder(cart: Cart, region: string): Order {
  const { totalCents: netCents, itemCount } = sumCart(cart);
  // Totals now include 20% VAT: totalCents is the gross amount, no longer the net sum of line items.
  const totalCents = Math.round(netCents * 1.2);
  const id = \`ord-\${itemCount}-\${totalCents}\`;
  return { id, region, currency: "USD", itemCount, totalCents };
}
`;

// The API agent updates its OWN unit test together with the VAT change, so
// its check stays green — only the consumers' expectations are now wrong.
export const ORDER_TEST_VAT = `import { createOrder } from "../src/api/order.ts";
import type { Cart } from "../src/api/order.ts";

export async function run(): Promise<Array<{ name: string; ok: boolean; error?: string }>> {
  const cart: Cart = {
    items: [
      { sku: "sku-1", qty: 2, unitPrice: 500 },
      { sku: "sku-2", qty: 1, unitPrice: 300 },
    ],
  };
  // Totals include 20% VAT (1300 net -> 1560 gross); stays green across the
  // v1 -> v2 signature migration exercised by the demo scenario.
  const order = createOrder(cart, "eu" as never);
  return [
    { name: "createOrder totals include VAT", ok: order.totalCents === 1560 && order.itemCount === 3 },
    { name: "createOrder deterministic id", ok: order.id === "ord-3-1560" },
  ];
}
`;

// Breaking change on top of the VAT behavior: same as ORDER_V2, but the
// gross (VAT-inclusive) total is what gets converted.
export const ORDER_V2_VAT = `export interface LineItem {
  sku: string;
  qty: number;
  unitPrice: number;
}

export interface Cart {
  items: LineItem[];
}

export interface Order {
  id: string;
  region: string;
  currency: string;
  itemCount: number;
  totalCents: number;
}

function sumCart(cart: Cart): { totalCents: number; itemCount: number } {
  let totalCents = 0;
  let itemCount = 0;
  for (const item of cart.items) {
    totalCents += item.qty * item.unitPrice;
    itemCount += item.qty;
  }
  return { totalCents, itemCount };
}

export function createOrder(cart: Cart, opts: { region: string; currency: string }): Order {
  const { totalCents: netCents, itemCount } = sumCart(cart);
  // Totals include 20% VAT.
  const grossCents = Math.round(netCents * 1.2);
  const converted = opts.currency === "EUR" ? Math.round((grossCents * 92) / 100) : grossCents;
  return {
    id: \`ord-\${itemCount}-\${converted}\`,
    region: opts.region,
    currency: opts.currency,
    itemCount,
    totalCents: converted,
  };
}
`;

// Body-only refactor: identical exported interface, so the control plane's
// interface hash is unchanged and the push must produce an early cutoff.
export const ORDER_V1_REFACTORED = `export interface LineItem {
  sku: string;
  qty: number;
  unitPrice: number;
}

export interface Cart {
  items: LineItem[];
}

export interface Order {
  id: string;
  region: string;
  itemCount: number;
  totalCents: number;
}

function sumCart(cart: Cart): { totalCents: number; itemCount: number } {
  let totalCents = 0;
  let itemCount = 0;
  for (const item of cart.items) {
    totalCents += item.qty * item.unitPrice;
    itemCount += item.qty;
  }
  return { totalCents, itemCount };
}

export function createOrder(cart: Cart, region: string): Order {
  const { totalCents, itemCount } = sumCart(cart);
  return { id: \`ord-\${itemCount}-\${totalCents}\`, region, itemCount, totalCents };
}
`;

// Breaking change: createOrder now takes { region, currency } and Order gains a
// currency field. Both consumed symbol hashes change -> consumers get squashed.
export const ORDER_V2 = `export interface LineItem {
  sku: string;
  qty: number;
  unitPrice: number;
}

export interface Cart {
  items: LineItem[];
}

export interface Order {
  id: string;
  region: string;
  currency: string;
  itemCount: number;
  totalCents: number;
}

function sumCart(cart: Cart): { totalCents: number; itemCount: number } {
  let totalCents = 0;
  let itemCount = 0;
  for (const item of cart.items) {
    totalCents += item.qty * item.unitPrice;
    itemCount += item.qty;
  }
  return { totalCents, itemCount };
}

export function createOrder(cart: Cart, opts: { region: string; currency: string }): Order {
  const { totalCents, itemCount } = sumCart(cart);
  const converted = opts.currency === "EUR" ? Math.round((totalCents * 92) / 100) : totalCents;
  return {
    id: \`ord-\${itemCount}-\${converted}\`,
    region: opts.region,
    currency: opts.currency,
    itemCount,
    totalCents: converted,
  };
}
`;

function writeOrder(dir: string, source: string): void {
  fs.writeFileSync(path.join(dir, "src/api/order.ts"), source);
}

export function startApiAgent(opts: {
  api: ApiClient;
  workRoot: string;
  log: Log;
  pollMs?: number;
  timeoutMs?: number;
  firstPushDelayMs?: number;
  /** Delay before the body-only refactor push (stub runs only). Must be long
   * enough for the stub-resolving push to be detected and the prediction-miss
   * re-fork to land, so the cutoff is attributable to a push of its own. */
  bodyOnlyDelayMs?: number;
  breakingChangeDelayMs?: number;
  /** Declared-stub value prediction (T11). When set, the run is three pushes:
   * the signature-as-declared refactor that nonetheless adds a field to Order
   * (resolves predictions), then a body-only refactor (early cutoff), then
   * the breaking change (squashes). */
  stub?: Record<string, string>;
  /** (V2) Delay before the same-signature behavior change (VAT added to
   * totals), pushed between the body-only refactor and the breaking change.
   * Unset = no behavior beat (v1 sequence). Must leave time for Jev to judge
   * the refactor first, and the breaking change delay must leave time for the
   * behavior verdict + semantic re-fork. */
  behaviorChangeDelayMs?: number;
}): AgentHandle {
  const firstDelay = opts.firstPushDelayMs ?? 500;
  const bodyDelay = opts.bodyOnlyDelayMs ?? 1500;
  const breakDelay = opts.breakingChangeDelayMs ?? 10_000;
  const vat = opts.behaviorChangeDelayMs !== undefined;
  const stepsFor = (gen: number): Step[] => [
    ...(gen === 0
      ? [
          {
            delayMs: firstDelay,
            message: opts.stub
              ? "refactor(api): extract sumCart; add currency to Order"
              : "refactor(api): extract sumCart helper from createOrder",
            apply: (dir: string) => writeOrder(dir, opts.stub ? ORDER_V1_1 : ORDER_V1_REFACTORED),
          },
          ...(opts.stub
            ? [
                {
                  delayMs: bodyDelay,
                  message: "refactor(api): reimplement sumCart with reduce",
                  apply: (dir: string) => writeOrder(dir, ORDER_V1_1_REFACTORED),
                },
              ]
            : []),
          ...(vat
            ? [
                {
                  delayMs: opts.behaviorChangeDelayMs,
                  message: "feat(api): order totals include 20% VAT",
                  apply: (dir: string) => {
                    writeOrder(dir, ORDER_V1_1_VAT);
                    fs.writeFileSync(path.join(dir, "tests/order.test.ts"), ORDER_TEST_VAT);
                  },
                },
              ]
            : []),
        ]
      : []),
    {
      delayMs: gen === 0 ? breakDelay : 0,
      message: "feat(api)!: createOrder now takes { region, currency } options",
      apply: (dir: string) => writeOrder(dir, vat ? ORDER_V2_VAT : ORDER_V2),
    },
  ];
  return startAgent({
    api: opts.api,
    agent: "api-agent",
    lane: "api",
    workRoot: opts.workRoot,
    log: opts.log,
    pollMs: opts.pollMs,
    timeoutMs: opts.timeoutMs,
    stepsFor,
    stub: opts.stub,
  });
}
