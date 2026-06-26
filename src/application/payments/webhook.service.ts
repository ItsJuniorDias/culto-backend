import type { FastifyBaseLogger } from 'fastify';
import type { OrderRepository } from '../../domain/orders/order.repository.js';
import type {
  PaymentGateway,
  RawWebhookRequest,
} from '../../domain/payments/payment-gateway.js';
import type { OnOrderPaid } from './on-order-paid.js';

export interface WebhookServiceDeps {
  orders: OrderRepository;
  gateway: PaymentGateway;
  onOrderPaid: OnOrderPaid;
  logger: FastifyBaseLogger;
}

export interface WebhookOutcome {
  received: true;
  orderId?: string;
  status?: string;
  /** Falso quando o pedido não foi achado ou o status não mudou. */
  applied: boolean;
}

export class WebhookService {
  constructor(private readonly deps: WebhookServiceDeps) {}

  /**
   * Processa um webhook do gateway. O adapter VALIDA a assinatura e normaliza
   * o evento (lança WebhookSignatureError se a assinatura não bater — o
   * error-handler responde 401). A atualização do pedido é idempotente, então
   * reentregas do gateway são seguras.
   */
  async handle(req: RawWebhookRequest): Promise<WebhookOutcome> {
    const event = await this.deps.gateway.parseWebhook(req);

    // Acha o pedido pela referência externa (nosso id) ou pelo id do gateway.
    const order =
      (event.orderId ? await this.deps.orders.findById(event.orderId) : null) ??
      (await this.deps.orders.findByGatewayId(event.gatewayId));

    if (!order) {
      // 200 mesmo assim: não queremos que o gateway fique reenviando pra
      // sempre por um pedido que não conhecemos (ex.: de outro ambiente).
      this.deps.logger.warn(
        { gatewayId: event.gatewayId, orderId: event.orderId },
        'webhook de pedido desconhecido — ignorado',
      );
      return { received: true, applied: false };
    }

    // Garante o vínculo (caso o webhook chegue antes do save com gatewayId).
    if (!order.gatewayId) order.linkGateway(event.gatewayId);

    const changed = order.applyStatus(event.status);
    await this.deps.orders.save(order);

    if (changed && order.status === 'paid') {
      try {
        await this.deps.onOrderPaid(order);
      } catch (err) {
        this.deps.logger.error({ err, orderId: order.id }, 'onOrderPaid (webhook) falhou');
      }
    }

    this.deps.logger.info(
      { orderId: order.id, status: order.status, type: event.type, changed },
      'webhook processado',
    );
    return { received: true, orderId: order.id, status: order.status, applied: changed };
  }
}
