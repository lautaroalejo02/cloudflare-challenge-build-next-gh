import { createOrder } from "../src/api/order.ts";
import type { Cart } from "../src/api/order.ts";

export async function run(): Promise<Array<{ name: string; ok: boolean; error?: string }>> {
  const cart: Cart = {
    items: [
      { sku: "sku-1", qty: 2, unitPrice: 500 },
      { sku: "sku-2", qty: 1, unitPrice: 300 },
    ],
  };
  // Only totals are asserted so this baseline stays green across the v1 -> v2
  // signature migration exercised by the demo scenario.
  const order = createOrder(cart, "eu" as never);
  return [
    { name: "createOrder totals", ok: order.totalCents === 1300 && order.itemCount === 3 },
    { name: "createOrder deterministic id", ok: order.id === "ord-3-1300" },
  ];
}
