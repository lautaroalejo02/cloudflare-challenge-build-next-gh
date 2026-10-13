import { charge } from "../api/payment.ts";

export function renderPaywall(orderId: string, amountCents: number): string {
	const receipt = charge({ orderId, amountCents, method: "card" });
	return `PAY ${receipt.id}: ${receipt.chargedCents} cents via ${receipt.method}`;
}
