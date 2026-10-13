import fs from "node:fs";
import path from "node:path";
import type { ApiClient } from "../lib/http.ts";
import type { Log } from "../lib/types.ts";
import { startAgent, type AgentHandle } from "./base.ts";

// Payments consumer for the T14 multi scenario: appends a fast-pay renderer
// to paywall.ts, adapted to the charge() signature found in the cloned fork.
// v2 is the breaking change where PaymentRequest requires `currency`.

const FEATURE_V1 = [
	"export function renderFastPay(orderId: string, amountCents: number): string {",
	'  const receipt = charge({ orderId, amountCents, method: "transfer" });',
	"  return `FASTPAY ${receipt.id}: ${receipt.chargedCents} cents`;",
	"}",
	"",
].join("\n");

const FEATURE_V2 = [
	"export function renderFastPay(orderId: string, amountCents: number): string {",
	'  const receipt = charge({ orderId, amountCents, method: "transfer", currency: "EUR" });',
	"  return `FASTPAY ${receipt.id}: ${receipt.chargedCents} ${receipt.currency}`;",
	"}",
	"",
].join("\n");

// v2 adds `currency` to PaymentRequest — the v1 fixture source has none.
export function detectChargeVersion(paymentSource: string): "v1" | "v2" {
	return /currency/.test(paymentSource) ? "v2" : "v1";
}

function applyPaywallFeature(dir: string, log: Log): void {
	const paySrc = fs.readFileSync(path.join(dir, "src/api/payment.ts"), "utf8");
	const sig = detectChargeVersion(paySrc);
	const paywallPath = path.join(dir, "src/ui/paywall.ts");
	const base = fs
		.readFileSync(paywallPath, "utf8")
		.replace(/\n?export function renderFastPay[\s\S]*$/, "")
		.trimEnd();
	log(`detected charge signature ${sig} - applying ${sig} paywall variant`);
	fs.writeFileSync(paywallPath, `${base}\n\n${sig === "v2" ? FEATURE_V2 : FEATURE_V1}`);
}

export function startPayUiAgent(opts: {
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
		agent: "pay-ui-agent",
		lane: "ui",
		producerId: opts.producerId,
		// `charge`'s own signature text is unchanged in v2 (the request shape
		// is what breaks) — consuming PaymentRequest is what catches it.
		consumes: opts.consumes ?? ["charge", "PaymentRequest"],
		workRoot: opts.workRoot,
		log: opts.log,
		pollMs: opts.pollMs,
		timeoutMs: opts.timeoutMs,
		stepsFor: (gen) => [
			{
				delayMs: 300,
				message:
					gen === 0
						? "feat(ui): fast-pay line"
						: "feat(ui): reapply fast-pay for new charge interface",
				apply: (dir) => applyPaywallFeature(dir, opts.log),
			},
		],
	});
}
