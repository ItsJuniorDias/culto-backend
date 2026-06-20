import type { FastifyInstance } from 'fastify';
import type { Container } from '../../container.js';
import { parse } from '../validation.js';
import { providerParamSchema } from '../schemas/checkout.schema.js';

/**
 * POST /api/webhooks/:provider
 *
 * Endpoint que o GATEWAY chama (server-to-server) quando o status muda. A
 * assinatura é validada DENTRO do adapter (parseWebhook); se não bater, o
 * error-handler responde 401. Sempre 200 quando processado, pra evitar
 * reentrega infinita.
 *
 * Precisa do corpo CRU pra conferir a assinatura — garantido pelo plugin
 * registerRawBody.
 */
export function registerWebhookRoutes(app: FastifyInstance, c: Container): void {
  app.post('/api/webhooks/:provider', async (request, reply) => {
    const { provider } = parse(providerParamSchema, request.params);

    // Garante que o webhook chegou na rota do provider ativo.
    if (provider !== c.gateway.name) {
      reply.status(404).send({
        error: { code: 'NOT_FOUND', message: `Provider "${provider}" não está ativo.` },
      });
      return;
    }

    const outcome = await c.webhooks.handle({
      headers: request.headers,
      rawBody: request.rawBody ?? Buffer.alloc(0),
    });

    reply.status(200).send(outcome);
  });
}
