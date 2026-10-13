export interface PaymentRequest {
	orderId: string;
	amountCents: number;
	method: string;
}

export interface Receipt {
	id: string;
	chargedCents: number;
	method: string;
}

export function charge(req: PaymentRequest): Receipt {
	return { id: `rcpt-${req.orderId}`, chargedCents: req.amountCents, method: req.method };
}
