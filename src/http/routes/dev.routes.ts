import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { parse } from '../validation.js';
import { PAYMENT_STATUSES } from '../../domain/payments/payment.types.js';
import {
  MOCK_WEBHOOK_SIGNATURE_HEADER,
  signMockWebhook,
} from '../../domain/payments/gateways/mock-gateway.js';

const simulateWebhookSchema = z.object({
  orderId: z.string().min(1),
  status: z.enum(PAYMENT_STATUSES),
});

/**
 * Rotas de DESENVOLVIMENTO. Só entram no ar quando ENABLE_DEV_ROUTES=true e o
 * provider ativo é o "mock". Servem pra exercitar o fluxo ponta-a-ponta sem
 * gateway real — é o equivalente backend do "simular compra" do DevPanel do
 * front.
 *
 *   POST /api/dev/simulate-webhook  { orderId, status }
 *
 * Em vez de furar a camada de domínio, a rota MONTA um webhook de verdade
 * (corpo + assinatura HMAC) e o empurra pelo MESMO caminho que a PradaPay vai
 * usar amanhã. Assim o que se testa aqui é exatamente o que roda em produção.
 */
export function registerDevRoutes(app: FastifyInstance, c: Container): void {
  // Defesa em profundidade: se não for ambiente de dev/mock, nem registra.
  if (!c.env.ENABLE_DEV_ROUTES || c.gateway.name !== 'mock' || !c.mockWebhookSecret) {
    return;
  }
  const secret = c.mockWebhookSecret;

  app.post('/api/dev/simulate-webhook', async (request, reply) => {
    const { orderId, status } = parse(simulateWebhookSchema, request.body);

    const order = await c.orders.findById(orderId);
    if (!order) {
      reply.status(404).send({
        error: { code: 'ORDER_NOT_FOUND', message: `Pedido "${orderId}" não encontrado.` },
      });
      return;
    }

    // O webhook do gateway carrega o id DELE; reproduzimos isso fielmente.
    const gatewayId = order.gatewayId ?? orderId;
    const rawBody = JSON.stringify({
      event: `payment.${status}`,
      gatewayId,
      orderId,
      status,
    });
    const signature = signMockWebhook(secret, rawBody);

    const outcome = await c.webhooks.handle({
      headers: { [MOCK_WEBHOOK_SIGNATURE_HEADER]: signature },
      rawBody,
    });

    reply.status(200).send({ simulated: true, ...outcome });
  });

  app.log.warn('rotas de DEV habilitadas — não use ENABLE_DEV_ROUTES em produção');
}
