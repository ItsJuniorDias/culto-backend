import type { FastifyInstance, FastifyBaseLogger } from 'fastify';
import type { Env } from './config/env.js';
import { CatalogService } from './domain/catalog/catalog.service.js';
import { CouponService } from './domain/coupons/coupon.service.js';
import { InMemoryOrderRepository } from './domain/orders/in-memory-order.repository.js';
import type { OrderRepository } from './domain/orders/order.repository.js';
import type { PaymentGateway } from './domain/payments/payment-gateway.js';
import { MockGateway } from './domain/payments/gateways/mock-gateway.js';
import { PradaPayGateway } from './domain/payments/gateways/pradapay-gateway.js';
import { CheckoutService } from './application/checkout/checkout.service.js';
import { WebhookService } from './application/payments/webhook.service.js';
import { defaultOnOrderPaid, type OnOrderPaid } from './application/payments/on-order-paid.js';

/** Secret do webhook MOCK (não é sigiloso; só pra exercitar o HMAC em dev). */
export const MOCK_WEBHOOK_SECRET = 'culto-mock-secret';

/**
 * Container de dependências. É o ÚNICO lugar que decide qual implementação
 * concreta usar (mock x PradaPay, memória x banco). Trocar de gateway é
 * trocar uma variável de ambiente — o wiring acontece aqui.
 */
export interface Container {
  env: Env;
  logger: FastifyBaseLogger;
  gateway: PaymentGateway;
  orders: OrderRepository;
  catalog: CatalogService;
  coupons: CouponService;
  onOrderPaid: OnOrderPaid;
  checkout: CheckoutService;
  webhooks: WebhookService;
  /** Disponível só quando o provider é "mock"; usado pela rota de simulação. */
  mockWebhookSecret: string | null;
}

function buildGateway(env: Env): { gateway: PaymentGateway; mockSecret: string | null } {
  if (env.PAYMENT_PROVIDER === 'pradapay') {
    const gateway = new PradaPayGateway({
      apiKey: env.PRADAPAY_API_KEY ?? '',
      baseUrl: env.PRADAPAY_BASE_URL,
      webhookSecret: env.PRADAPAY_WEBHOOK_SECRET ?? '',
    });
    return { gateway, mockSecret: null };
  }

  const gateway = new MockGateway({
    autoApprove: {
      card: env.MOCK_AUTO_APPROVE_CARD,
      pix: env.MOCK_AUTO_APPROVE_PIX,
      boleto: env.MOCK_AUTO_APPROVE_BOLETO,
    },
    webhookSecret: MOCK_WEBHOOK_SECRET,
  });
  return { gateway, mockSecret: MOCK_WEBHOOK_SECRET };
}

export function buildContainer(app: FastifyInstance, env: Env): Container {
  const logger = app.log;
  const { gateway, mockSecret } = buildGateway(env);

  const orders = new InMemoryOrderRepository();
  const catalog = new CatalogService();
  const coupons = new CouponService();
  const onOrderPaid = defaultOnOrderPaid(logger);

  const checkout = new CheckoutService({
    env,
    catalog,
    coupons,
    orders,
    gateway,
    onOrderPaid,
    logger,
  });

  const webhooks = new WebhookService({ orders, gateway, onOrderPaid, logger });

  return {
    env,
    logger,
    gateway,
    orders,
    catalog,
    coupons,
    onOrderPaid,
    checkout,
    webhooks,
    mockWebhookSecret: mockSecret,
  };
}
