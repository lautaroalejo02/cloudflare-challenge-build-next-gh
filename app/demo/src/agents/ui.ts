import fs from "node:fs";
import path from "node:path";
import type { ApiClient } from "../lib/http.ts";
import { detectCreateOrderVersion } from "../lib/signatures.ts";
import type { Log } from "../lib/types.ts";
import { startAgent, type AgentHandle } from "./base.ts";

// Mocked agent intelligence: the "feature" is appended to checkout.ts; the
// variant is picked by sniffing the producer's createOrder signature in the
// freshly cloned fork.
const FEATURE_V1 = [
  "export function renderExpressCheckout(cart: Cart, region: string): string {",
  "  const order = createOrder(cart, region);",
  "  return `EXPRESS ${order.id} -> ${order.region}: ${order.itemCount} items = ${order.totalCents} cents`;",
  "}",
  "",
].join("\n");

const FEATURE_V2 = [
  "export function renderExpressCheckout(cart: Cart, region: string, currency: string): string {",
  "  const order = createOrder(cart, { region, currency });",
  "  return `EXPRESS ${order.id} -> ${order.region}: ${order.itemCount} items = ${order.totalCents} ${order.currency}`;",
  "}",
  "",
].join("\n");

function applyCheckoutFeature(dir: string, log: Log): void {
  const orderSrc = fs.readFileSync(path.join(dir, "src/api/order.ts"), "utf8");
  const sig = detectCreateOrderVersion(orderSrc);
  const checkoutPath = path.join(dir, "src/ui/checkout.ts");
  const base = fs
    .readFileSync(checkoutPath, "utf8")
    .replace(/\n?export function renderExpressCheckout[\s\S]*$/, "")
    .trimEnd();
  log(`detected createOrder signature ${sig} - applying ${sig} checkout variant`);
  fs.writeFileSync(checkoutPath, `${base}\n\n${sig === "v2" ? FEATURE_V2 : FEATURE_V1}`);
}

export function startUiAgent(opts: {
  api: ApiClient;
  workRoot: string;
  log: Log;
  producerId: string;
  consumes?: string[];
  pollMs?: number;
  timeoutMs?: number;
}): AgentHandle {
  return startAgent({
    api: opts.api,
    agent: "ui-agent",
    lane: "ui",
    producerId: opts.producerId,
    consumes: opts.consumes ?? ["createOrder", "Order"],
    workRoot: opts.workRoot,
    log: opts.log,
    pollMs: opts.pollMs,
    timeoutMs: opts.timeoutMs,
    stepsFor: (gen) => [
      {
        delayMs: 300,
        message:
          gen === 0
            ? "feat(ui): express checkout line"
            : "feat(ui): reapply express checkout for new createOrder interface",
        apply: (dir) => applyCheckoutFeature(dir, opts.log),
      },
    ],
  });
}
