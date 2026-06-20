import type { FastifyInstance } from 'fastify';
import type { Container } from '../../container.js';
import { parse } from '../validation.js';
import { createCheckoutSchema, orderIdParamSchema } from '../schemas/checkout.schema.js';

/**
 * Rotas do checkout.
 *
 *   POST /api/checkout/sessions      cria pedido + cobrança no gateway
 *   GET  /api/checkout/sessions/:id  estado do pedido (retorno + polling do Pix)
 */
export function registerCheckoutRoutes(app: FastifyInstance, c: Container): void {
  app.post('/api/checkout/sessions', async (request, reply) => {
    const body = parse(createCheckoutSchema, request.body);
    const result = await c.checkout.createCheckout({
      packId: body.packId,
      paymentMethod: body.paymentMethod,
      customer: {
        email: body.customer.email,
        cpf: body.customer.cpf,
        ...(body.customer.name ? { name: body.customer.name } : {}),
      },
      ...(body.couponCode ? { couponCode: body.couponCode } : {}),
      ...(body.installments ? { installments: body.installments } : {}),
      ...(body.cardToken ? { cardToken: body.cardToken } : {}),
    });
    reply.status(201).send(result);
  });

  app.get('/api/checkout/sessions/:id', async (request) => {
    const { id } = parse(orderIdParamSchema, request.params);
    return c.checkout.getStatus(id);
  });
}
