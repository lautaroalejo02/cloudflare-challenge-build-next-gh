import fs from "node:fs";
import path from "node:path";
import type { ApiClient } from "../lib/http.ts";
import { detectCreateOrderVersion, detectVat, type SigVersion } from "../lib/signatures.ts";
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

// Expected totals for the fixed cart (2 x 500 cents): net 1000, or 1200 once
// the producer adds 20% VAT; v2 converts to EUR at 0.92.
function expectedTotal(sig: SigVersion, vat: boolean): number {
  const gross = vat ? 1200 : 1000;
  return sig === "v2" ? Math.round((gross * 92) / 100) : gross;
}

function body(sig: SigVersion, failing: boolean, vat: boolean): string {
  const total = failing ? 999 : expectedTotal(sig, vat);
  const label = vat ? " incl. VAT" : "";
  if (sig === "v2") {
    return [
      '  const order = createOrder(cart, { region: "eu", currency: "EUR" });',
      "  return [",
      `    { name: "feature: EUR conversion${label}", ok: order.totalCents === ${total} },`,
      '    { name: "feature: currency+region", ok: order.currency === "EUR" && order.region === "eu" },',
      "  ];",
    ].join("\n");
  }
  return [
    '  const order = createOrder(cart, "eu");',
    "  return [",
    `    { name: "feature: totals${label}", ok: order.totalCents === ${total} && order.itemCount === 2 },`,
    '    { name: "feature: region", ok: order.region === "eu" },',
    "  ];",
  ].join("\n");
}

export function featureTestSource(sig: SigVersion, failing: boolean, vat = false): string {
  return `${HEADER}\n${body(sig, failing, vat)}\n${FOOTER}\n`;
}

function writeFeatureTest(dir: string, failing: boolean, log: Log): void {
  const orderSrc = fs.readFileSync(path.join(dir, "src/api/order.ts"), "utf8");
  const sig = detectCreateOrderVersion(orderSrc);
  const vat = detectVat(orderSrc);
  log(`detected createOrder signature ${sig}${vat ? " with VAT totals" : ""} - writing ${sig}${failing ? " FAILING" : ""} feature test (expects ${expectedTotal(sig, vat)})`);
  fs.writeFileSync(path.join(dir, "tests/create-order.feature.test.ts"), featureTestSource(sig, failing, vat));
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
  // failFirst writes the FAILING variant on every apply until the scripted
  // fix lands: retirement is in-order, so the consumer's gen-0 commit is
  // always squashed before it can be checked — the failing check only runs
  // on the commit that survives to be head (gen-1 on the live plane).
  let corrected = false;
  const stepsFor = (gen: number): Step[] => [
    {
      delayMs: 300,
      message:
        gen === 0
          ? "test: add createOrder feature coverage"
          : "test: reapply feature coverage for new createOrder interface/behavior",
      apply: (dir) => writeFeatureTest(dir, !!opts.failFirst && !corrected, opts.log),
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
      apply: (d) => {
        corrected = true;
        writeFeatureTest(d, false, opts.log);
      },
    }),
  });
}
