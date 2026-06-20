import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { type Env, corsOrigins } from './config/env.js';
import { buildContainer } from './container.js';
import { registerRawBody } from './http/plugins/raw-body.js';
import { registerErrorHandler } from './http/plugins/error-handler.js';
import { registerPublicRoutes } from './http/routes/public.routes.js';
import { registerCouponRoutes } from './http/routes/coupon.routes.js';
import { registerCheckoutRoutes } from './http/routes/checkout.routes.js';
import { registerWebhookRoutes } from './http/routes/webhook.routes.js';
import { registerDevRoutes } from './http/routes/dev.routes.js';

/**
 * Fábrica do app. Monta o Fastify com plugins, container (injeção de
 * dependências) e rotas, mas NÃO sobe o servidor — quem dá o listen é o
 * server.ts. Separar assim deixa o app testável (smoke test usa inject()).
 */
export async function buildApp(env: Env): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      // Em dev, log legível; em produção, JSON puro (mais fácil de coletar).
      ...(env.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } }
        : {}),
    },
    // Confia no proxy (Render/Fly/Nginx) pra IP e protocolo corretos.
    trustProxy: true,
  });

  // ORDEM IMPORTA: o parser de corpo cru precisa entrar antes das rotas, pra
  // o webhook conseguir conferir a assinatura sobre os bytes originais.
  registerRawBody(app);

  await app.register(cors, {
    origin: corsOrigins(env),
    methods: ['GET', 'POST'],
  });

  registerErrorHandler(app);

  // Composition root: tudo que as rotas usam vem daqui.
  const container = buildContainer(app, env);

  registerPublicRoutes(app, container);
  registerCouponRoutes(app, container);
  registerCheckoutRoutes(app, container);
  registerWebhookRoutes(app, container);
  registerDevRoutes(app, container);

  return app;
}
