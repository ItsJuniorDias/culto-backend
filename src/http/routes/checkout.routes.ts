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
    // [CULTO-DEBUG] visibilidade do telefone ponta a ponta (remova quando estabilizar)
    request.log.info(
      {
        method: body.paymentMethod,
        rawCustomerKeys: Object.keys((request.body as Record<string, unknown>)?.customer as object ?? {}),
        parsedCustomerKeys: Object.keys(body.customer),
        hasPhone: Boolean(body.customer.phone),
        phone: body.customer.phone ?? null,
      },
      '[CULTO-DEBUG] /checkout/sessions recebido',
    );
    const result = await c.checkout.createCheckout({
      packId: body.packId,
      paymentMethod: body.paymentMethod,
      customer: {
        email: body.customer.email,
        cpf: body.customer.cpf,
        ...(body.customer.name ? { name: body.customer.name } : {}),
        ...(body.customer.phone ? { phone: body.customer.phone } : {}),
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
