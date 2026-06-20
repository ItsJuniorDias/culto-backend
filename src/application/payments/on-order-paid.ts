import type { FastifyBaseLogger } from 'fastify';
import type { Order } from '../../domain/orders/order.js';

/**
 * Gancho disparado UMA vez quando um pedido vira "paid" (seja via mock,
 * simulação de webhook ou webhook real da PradaPay).
 *
 * É AQUI que, no futuro, você libera o pack pro usuário: gravar a posse na
 * conta (entitlement), mandar e-mail com o link, liberar o download protegido
 * etc. Por ora, só registra no log — mas o ponto de extensão já existe e é
 * idempotente (a transição de status garante "uma vez só").
 */
export type OnOrderPaid = (order: Order) => Promise<void> | void;

/** Implementação padrão: apenas loga. Troque/decore quando tiver entitlements. */
export function defaultOnOrderPaid(logger: FastifyBaseLogger): OnOrderPaid {
  return (order) => {
    const o = order.snapshot();
    logger.info(
      { orderId: o.id, packId: o.packId, totalCents: o.totalCents, email: o.customer.email },
      'pedido pago — liberar o pack para o usuário (TODO: entitlement)',
    );
  };
}
