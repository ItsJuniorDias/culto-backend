import type { Order } from './order.js';
import type { OrderRepository } from './order.repository.js';

/**
 * Adapter em memória. Bom pra dev e testes. Em produção, troque por um que
 * fale com banco — a interface (OrderRepository) é a mesma.
 *
 * Mantém dois índices: por id do pedido e por id do gateway (usado no webhook).
 */
export class InMemoryOrderRepository implements OrderRepository {
  private byId = new Map<string, Order>();
  private byGatewayId = new Map<string, Order>();

  async save(order: Order): Promise<void> {
    this.byId.set(order.id, order);
    if (order.gatewayId) {
      this.byGatewayId.set(order.gatewayId, order);
    }
  }

  async findById(id: string): Promise<Order | null> {
    return this.byId.get(id) ?? null;
  }

  async findByGatewayId(gatewayId: string): Promise<Order | null> {
    return this.byGatewayId.get(gatewayId) ?? null;
  }
}
