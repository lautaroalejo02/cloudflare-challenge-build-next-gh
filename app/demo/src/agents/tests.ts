import fs from "node:fs";
import path from "node:path";
import type { ApiClient } from "../lib/http.ts";
import { detectCreateOrderVersion, type SigVersion } from "../lib/signatures.ts";
import type { Log } from "../lib/types.ts";
import { startAgent, type AgentHandle, type Step } from "./base.ts";

const HEADER = [
  'import { createOrder } from "../src/api/order.ts";',
  'import type { Cart } from "../src/api/order.ts";',
  "",
  "export async function run(): Promise<Array<{ name: string; ok: boolean; error?: string }>> {",
  '  const cart: Cart = { items: [{ sku: "sku-9", qty: 2, unitPrice: 500 }] };',
].join("\n");

const FOOTER = ["}"].join("\n");

function body(sig: SigVersion, failing: boolean): string {
  if (sig === "v2") {
    return [
      '  const order = createOrder(cart, { region: "eu", currency: "EUR" });',
      "  return [",
      `    { name: "feature: EUR conversion", ok: order.totalCents === ${failing ? 999 : 920} },`,
      '    { name: "feature: currency+region", ok: order.currency === "EUR" && order.region === "eu" },',
      "  ];",
    ].join("\n");
  }
  return [
    '  const order = createOrder(cart, "eu");',
    "  return [",
    `    { name: "feature: totals", ok: order.totalCents === ${failing ? 999 : 1000} && order.itemCount === 2 },`,
    '    { name: "feature: region", ok: order.region === "eu" },',
    "  ];",
  ].join("\n");
}

export function featureTestSource(sig: SigVersion, failing: boolean): string {
  return `${HEADER}\n${body(sig, failing)}\n${FOOTER}\n`;
}

function writeFeatureTest(dir: string, failing: boolean, log: Log): void {
  const orderSrc = fs.readFileSync(path.join(dir, "src/api/order.ts"), "utf8");
  const sig = detectCreateOrderVersion(orderSrc);
  log(`detected createOrder signature ${sig} - writing ${sig}${failing ? " FAILING" : ""} feature test`);
  fs.writeFileSync(path.join(dir, "tests/create-order.feature.test.ts"), featureTestSource(sig, failing));
}

export function startTestsAgent(opts: {
  api: ApiClient;
  workRoot: string;
  log: Log;
  producerId: string;
  consumes?: string[];
  failFirst?: boolean;
  pollMs?: number;
  timeoutMs?: number;
}): AgentHandle {
  let firstApplied = false;
  const stepsFor = (gen: number): Step[] => [
    {
      delayMs: 300,
      message:
        gen === 0
          ? "test: add createOrder feature coverage"
          : "test: reapply feature coverage for new createOrder interface",
      apply: (dir) => {
        const failing = !!opts.failFirst && !firstApplied;
        firstApplied = true;
        writeFeatureTest(dir, failing, opts.log);
      },
    },
  ];
  return startAgent({
    api: opts.api,
    agent: "tests-agent",
    lane: "tests",
    producerId: opts.producerId,
    consumes: opts.consumes ?? ["createOrder"],
    workRoot: opts.workRoot,
    log: opts.log,
    pollMs: opts.pollMs,
    timeoutMs: opts.timeoutMs,
    stepsFor,
    fixForFailure: (dir) => ({
      message: "test: fix wrong expectation in feature coverage",
      apply: (d) => writeFeatureTest(d, false, opts.log),
    }),
  });
}
