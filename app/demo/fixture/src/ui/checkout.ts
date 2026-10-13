import { createOrder } from "../api/order.ts";
import type { Cart } from "../api/order.ts";

export function renderCheckoutSummary(cart: Cart, region: string): string {
  const order = createOrder(cart, region);
  return `order ${order.id}: ${order.itemCount} items, total ${order.totalCents} cents (${order.region})`;
}
