import { charge } from "../src/api/payment.ts";

export async function run(): Promise<Array<{ name: string; ok: boolean; error?: string }>> {
	const receipt = charge({ orderId: "ord-1", amountCents: 1200, method: "card" });
	return [
		{ name: "charge returns a receipt", ok: receipt.chargedCents === 1200 && receipt.id === "rcpt-ord-1" },
		{ name: "charge echoes the method", ok: receipt.method === "card" },
	];
}
