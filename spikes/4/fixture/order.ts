export interface CartItem {
  sku: string;
  qty: number;
}

export interface Cart {
  items: CartItem[];
  currency: string;
}

export interface Order {
  id: string;
  total: number;
  region: string;
}

export type Region = "us" | "eu" | "apac";

export const TAX_RATE = 0.2;

export function createOrder(cart: Cart, region: Region): Order {
  const total = cart.items.reduce((acc, i) => acc + i.qty, 0);
  return { id: `${region}-${total}`, total: total * (1 + TAX_RATE), region };
}

export const calcTax = (amount: number, rate?: number): number =>
  amount * (rate ?? TAX_RATE);

export class OrderService {
  private repo = "memory";
  constructor(private prefix: string) {}
  static of(prefix: string): OrderService {
    return new OrderService(prefix);
  }
  submit(cart: Cart, region: Region): Order {
    const o = createOrder(cart, region);
    return { ...o, id: `${this.prefix}:${o.id}` };
  }
}
