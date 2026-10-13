export interface LineItem {
  sku: string;
  qty: number;
  unitPrice: number;
}

export interface Cart {
  items: LineItem[];
}

export interface Order {
  id: string;
  region: string;
  itemCount: number;
  totalCents: number;
}

export function createOrder(cart: Cart, region: string): Order {
  let totalCents = 0;
  let itemCount = 0;
  for (const item of cart.items) {
    totalCents += item.qty * item.unitPrice;
    itemCount += item.qty;
  }
  return { id: `ord-${itemCount}-${totalCents}`, region, itemCount, totalCents };
}
