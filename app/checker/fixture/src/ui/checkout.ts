import { createOrder, type CartItem, type Order } from "../api/order.ts";

export interface Receipt extends Order {
	label: string;
}

export function checkout(cart: CartItem[], region: string): Receipt {
	const order = createOrder(cart, region);
	return { ...order, label: `#${order.id}` };
}
