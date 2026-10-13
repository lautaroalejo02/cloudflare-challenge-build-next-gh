import fs from "node:fs";
import path from "node:path";
import type { ApiClient } from "../lib/http.ts";
import type { Log } from "../lib/types.ts";
import { startAgent, type AgentHandle, type Step } from "./base.ts";

// Payments producer for the T14 multi-component scenario. Two pushes mirror
// the orders flow: a body-only refactor (early cutoff) then a breaking change
// (PaymentRequest gains a required `currency`) that must squash only the
// payments consumer — never the orders component.

// Body-only refactor of the fixture payment.ts: identical exported interface.
const PAYMENT_V1_REFACTORED = `export interface PaymentRequest {
	orderId: string;
	amountCents: number;
	method: string;
}

export interface Receipt {
	id: string;
	chargedCents: number;
	method: string;
}

export function charge(req: PaymentRequest): Receipt {
	const chargedCents = req.amountCents;
	const id = ["rcpt", req.orderId].join("-");
	return { id, chargedCents, method: req.method };
}
`;

// Breaking change: PaymentRequest gains a required `currency`; charge signs
// the receipt with it. Consumed symbol hashes change -> the payments consumer
// gets squashed. The same commit rewrites payment.test.ts to the v2 call
// shape, or this entry's own checks would fail forever.
const PAYMENT_V2 = `export interface PaymentRequest {
	orderId: string;
	amountCents: number;
	method: string;
	currency: string;
}

export interface Receipt {
	id: string;
	chargedCents: number;
	method: string;
	currency: string;
}

export function charge(req: PaymentRequest): Receipt {
	const chargedCents = req.currency === "EUR" ? Math.round(req.amountCents * 0.92) : req.amountCents;
	return { id: \`rcpt-\${req.orderId}\`, chargedCents, method: req.method, currency: req.currency };
}
`;

const PAYMENT_TEST_V2 = `import { charge } from "../src/api/payment.ts";

export async function run(): Promise<Array<{ name: string; ok: boolean; error?: string }>> {
	const receipt = charge({ orderId: "ord-1", amountCents: 1200, method: "card", currency: "EUR" });
	return [
		{ name: "charge converts to EUR", ok: receipt.chargedCents === 1104 },
		{ name: "charge echoes method and currency", ok: receipt.method === "card" && receipt.currency === "EUR" },
	];
}
`;

function writePayment(dir: string, source: string): void {
	fs.writeFileSync(path.join(dir, "src/api/payment.ts"), source);
}

function writePaymentTest(dir: string, source: string): void {
	fs.writeFileSync(path.join(dir, "tests/payment.test.ts"), source);
}

export function startPayApiAgent(opts: {
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
						message: "refactor(api): tidy charge body",
						apply: (dir: string) => writePayment(dir, PAYMENT_V1_REFACTORED),
					},
				]
			: []),
		{
			delayMs: gen === 0 ? breakDelay : 0,
			message: "feat(api)!: charge takes a required currency",
			apply: (dir: string) => {
				writePayment(dir, PAYMENT_V2);
				writePaymentTest(dir, PAYMENT_TEST_V2);
			},
		},
	];
	return startAgent({
		api: opts.api,
		agent: "pay-api-agent",
		lane: "api",
		workRoot: opts.workRoot,
		log: opts.log,
		pollMs: opts.pollMs,
		timeoutMs: opts.timeoutMs,
		stepsFor,
	});
}
