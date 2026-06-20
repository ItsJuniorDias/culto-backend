import type { Order } from './order.js';

/**
 * PORTA do repositório de pedidos. Hoje tem um adapter em memória; trocar por
 * Postgres/Prisma depois é só criar outro adapter que implemente isto.
 */
export interface OrderRepository {
  save(order: Order): Promise<void>;
  findById(id: string): Promise<Order | null>;
  /** Necessário no webhook: o gateway manda o id DELE, não o nosso. */
  findByGatewayId(gatewayId: string): Promise<Order | null>;
}
