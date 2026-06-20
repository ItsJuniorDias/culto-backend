import { findCoupon, type Coupon } from './coupon.js';
import { CouponInvalidError } from '../../shared/errors.js';
import { formatBRL } from '../../shared/money.js';

export interface PricingBreakdown {
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  coupon: { code: string; label: string } | null;
  /** Versão formatada pra UI não precisar reformatar. */
  formatted: {
    subtotal: string;
    discount: string;
    total: string;
  };
}

export class CouponService {
  /**
   * Valida o código. Lança CouponInvalidError se não existir.
   * (Aqui é o ponto pra, no futuro, checar validade/uso por usuário/limite.)
   */
  validate(code: string): Coupon {
    const coupon = findCoupon(code);
    if (!coupon) throw new CouponInvalidError();
    return coupon;
  }

  /** Calcula o desconto (em centavos) de um cupom sobre um subtotal. */
  computeDiscount(subtotalCents: number, coupon: Coupon): number {
    const raw =
      coupon.type === 'percent'
        ? Math.round((subtotalCents * coupon.value) / 100)
        : coupon.value;
    // Nunca passa do subtotal (total não fica negativo).
    return Math.min(raw, subtotalCents);
  }

  /**
   * Monta o detalhamento de preço. `code` opcional: sem cupom => desconto 0.
   * Centraliza a regra pra checkout e validação usarem o MESMO cálculo.
   */
  price(subtotalCents: number, code?: string): PricingBreakdown {
    let discountCents = 0;
    let couponInfo: PricingBreakdown['coupon'] = null;

    if (code && code.trim()) {
      const coupon = this.validate(code);
      discountCents = this.computeDiscount(subtotalCents, coupon);
      couponInfo = { code: coupon.code, label: coupon.label };
    }

    const totalCents = Math.max(0, subtotalCents - discountCents);
    return {
      subtotalCents,
      discountCents,
      totalCents,
      coupon: couponInfo,
      formatted: {
        subtotal: formatBRL(subtotalCents),
        discount: formatBRL(discountCents),
        total: formatBRL(totalCents),
      },
    };
  }
}
