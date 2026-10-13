export interface CartItem {
	sku: string;
	price: number;
	qty: number;
}

export interface Order {
	id: string;
	region: string;
	total: number;
	itemCount: number;
}

export function createOrder(items: CartItem[], region: string): Order {
	const total = items.reduce((sum, i) => sum + i.price * i.qty, 0);
	return {
		id: `ord-${region}-${items.length}`,
		region,
		total: Math.round(total * 100) / 100,
		itemCount: items.reduce((sum, i) => sum + i.qty, 0),
	};
}
