/**
 * Tipos compartilhados do domínio de pagamento.
 *
 * `PaymentStatus` é o status NORMALIZADO da casa. Cada gateway tem o seu
 * vocabulário (approved, paid, CONFIRMED, settled...); os adapters traduzem
 * pra cá. O resto do sistema só conhece estes valores.
 */

export const PAYMENT_METHODS = ['card', 'pix', 'boleto'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = [
  'pending', // criado, aguardando pagamento (Pix não pago, boleto emitido)
  'processing', // em análise/autorização (cartão in_process)
  'paid', // aprovado/capturado
  'failed', // recusado/erro
  'expired', // Pix/boleto venceu sem pagar
  'refunded', // estornado
  'canceled', // cancelado
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Estados terminais — não mudam mais depois de atingidos. */
const TERMINAL: ReadonlySet<PaymentStatus> = new Set([
  'paid',
  'failed',
  'expired',
  'refunded',
  'canceled',
]);

export function isTerminal(status: PaymentStatus): boolean {
  return TERMINAL.has(status);
}
