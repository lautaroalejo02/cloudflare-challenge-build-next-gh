import fs from "node:fs";
import path from "node:path";
import type { ApiClient } from "../lib/http.ts";
import type { Log } from "../lib/types.ts";
import { startAgent, type AgentHandle, type Step } from "./base.ts";

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
  breakingChangeDelayMs?: number;
}): AgentHandle {
  const firstDelay = opts.firstPushDelayMs ?? 500;
  const breakDelay = opts.breakingChangeDelayMs ?? 10_000;
  const stepsFor = (gen: number): Step[] => [
    ...(gen === 0
      ? [
          {
            delayMs: firstDelay,
            message: "refactor(api): extract sumCart helper from createOrder",
            apply: (dir: string) => writeOrder(dir, ORDER_V1_REFACTORED),
          },
        ]
      : []),
    {
      delayMs: gen === 0 ? breakDelay : 0,
      message: "feat(api)!: createOrder now takes { region, currency } options",
      apply: (dir: string) => writeOrder(dir, ORDER_V2),
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
  });
}
