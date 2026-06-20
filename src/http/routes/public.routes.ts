import type { FastifyInstance } from 'fastify';
import type { Container } from '../../container.js';
import { parse } from '../validation.js';
import { orderIdParamSchema } from '../schemas/checkout.schema.js';

/** Rotas públicas de leitura: health + catálogo (preços do servidor). */
export function registerPublicRoutes(app: FastifyInstance, c: Container): void {
  app.get('/api/health', async () => ({
    status: 'ok',
    provider: c.env.PAYMENT_PROVIDER,
    time: new Date().toISOString(),
  }));

  app.get('/api/catalog', async () => ({ packs: c.catalog.list() }));

  app.get('/api/catalog/:id', async (request) => {
    const { id } = parse(orderIdParamSchema, request.params);
    return { pack: c.catalog.get(id) };
  });
}
