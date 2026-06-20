import type { FastifyInstance } from 'fastify';
import type { Container } from '../../container.js';
import { parse } from '../validation.js';
import { validateCouponSchema } from '../schemas/checkout.schema.js';

/**
 * POST /api/coupons/validate
 * Valida um cupom contra um pack e devolve o preço JÁ recalculado (subtotal,
 * desconto, total) — pro front mostrar o desconto sem inventar conta.
 */
export function registerCouponRoutes(app: FastifyInstance, c: Container): void {
  app.post('/api/coupons/validate', async (request) => {
    const { packId, code } = parse(validateCouponSchema, request.body);
    const pack = c.catalog.requirePurchasable(packId);
    // price() lança COUPON_INVALID (422) se o cupom não existir.
    const pricing = c.coupons.price(pack.priceCents, code);
    return { valid: true, pricing };
  });
}
