import { checkout } from "../src/ui/checkout.ts";

export async function run(): Promise<Array<{ name: string; ok: boolean; error?: string }>> {
	const order = checkout([{ sku: "s", price: 3, qty: 4 }], "us");
	const ok = order.label === "#ord-us-1" && order.total === 12;
	return [{ name: "checkout labels the order", ok, ...(ok ? {} : { error: `bad receipt: ${JSON.stringify(order)}` }) }];
}
