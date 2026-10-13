import { createOrder, type CartItem } from "../src/api/order.ts";

interface Check {
	name: string;
	ok: boolean;
	error?: string;
}

const eq = (a: unknown, b: unknown): void => {
	if (a !== b) throw new Error(`expected ${b}, got ${a}`);
};

export async function run(): Promise<Check[]> {
	const results: Check[] = [];
	const check = (name: string, fn: () => void): void => {
		try {
			fn();
			results.push({ name, ok: true });
		} catch (e) {
			results.push({ name, ok: false, error: String((e as Error)?.message ?? e) });
		}
	};

	const cart: CartItem[] = [
		{ sku: "a", price: 10, qty: 2 },
		{ sku: "b", price: 5, qty: 1 },
	];

	check("computes total", () => eq(createOrder(cart, "us").total, 25));
	check("sets region and id", () => {
		const o = createOrder([{ sku: "x", price: 1, qty: 1 }], "eu");
		eq(o.region, "eu");
		eq(o.id, "ord-eu-1");
	});
	check("counts items", () => eq(createOrder([{ sku: "x", price: 2, qty: 3 }], "us").itemCount, 3));

	return results;
}
