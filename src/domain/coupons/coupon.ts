/**
 * Cupons. Mesmos códigos do front (src/pages/Checkout.jsx), mas a aplicação
 * acontece no servidor — o desconto vira parte do total recalculado, então o
 * cliente não consegue inventar desconto.
 *
 * Tipos:
 *   - percent: desconto percentual (value = % inteiro)
 *   - amount:  desconto fixo em CENTAVOS
 */

export type CouponType = 'percent' | 'amount';

export interface Coupon {
  code: string;
  type: CouponType;
  /** percent => 10 (=10%) · amount => 5000 (=R$ 50,00) */
  value: number;
  label: string;
}

const COUPONS: ReadonlyArray<Coupon> = [
  { code: 'CULTO10', type: 'percent', value: 10, label: '10% OFF' },
  { code: 'PRIMEIRA', type: 'percent', value: 15, label: '15% OFF' },
  { code: 'CRIADOR', type: 'amount', value: 5_000, label: 'R$ 50 OFF' },
];

const BY_CODE = new Map(COUPONS.map((c) => [c.code, c]));

/** Busca case-insensitive, ignorando espaços. */
export function findCoupon(rawCode: string): Coupon | undefined {
  const code = (rawCode ?? '').trim().toUpperCase();
  if (!code) return undefined;
  return BY_CODE.get(code);
}
