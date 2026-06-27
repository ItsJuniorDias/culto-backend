import type { PaymentMethod, PaymentStatus } from '../../domain/payments/payment.types.js';
import type { PricingBreakdown } from '../../domain/coupons/coupon.service.js';

/** Entrada já validada (ver src/http/schemas/checkout.schema.ts). */
export interface CreateCheckoutInput {
  packId: string;
  paymentMethod: PaymentMethod;
  customer: {
    email: string;
    /** CPF só com dígitos. */
    cpf: string;
    name?: string | undefined;
  };
  couponCode?: string | undefined;
  installments?: number | undefined;
  cardToken?: string | undefined;
}

export interface OrderView {
  id: string;
  status: PaymentStatus;
  packId: string;
  packTitle: string;
  method: PaymentMethod;
  installments: number;
  pricing: PricingBreakdown;
  createdAt: string;
  paidAt: string | null;
}

export interface PaymentView {
  method: PaymentMethod;
  status: PaymentStatus;
  pix?: { copyPaste: string; qrCodeImage?: string; expiresAt: string };
  boleto?: { line: string; barcode: string; pdfUrl?: string; expiresAt: string };
  card?: { brand?: string; last4?: string; installments?: number };
}

/** Resposta de POST /api/checkout/sessions */
export interface CheckoutResult {
  order: OrderView;
  payment: PaymentView;
  /** Pra onde mandar o cliente depois de pagar. */
  returnUrl: string;
}

/** Resposta de GET /api/checkout/sessions/:id */
export interface CheckoutStatusResult {
  order: OrderView;
}
