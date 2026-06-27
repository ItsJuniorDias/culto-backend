import type { FastifyBaseLogger } from 'fastify';
import type { Env } from '../../config/env.js';
import type { CatalogService } from '../../domain/catalog/catalog.service.js';
import type { CouponService, PricingBreakdown } from '../../domain/coupons/coupon.service.js';
import type { OrderRepository } from '../../domain/orders/order.repository.js';
import type { PaymentGateway, ChargeResult } from '../../domain/payments/payment-gateway.js';
import { Order } from '../../domain/orders/order.js';
import { findCoupon } from '../../domain/coupons/coupon.js';
import { isTerminal } from '../../domain/payments/payment.types.js';
import { OrderNotFoundError } from '../../shared/errors.js';
import { formatBRL, resolveInstallment } from '../../shared/money.js';
import { newId } from '../../shared/id.js';
import type { OnOrderPaid } from '../payments/on-order-paid.js';
import type {
  CheckoutResult,
  CheckoutStatusResult,
  CreateCheckoutInput,
  OrderView,
  PaymentView,
} from './dto.js';

export interface CheckoutServiceDeps {
  env: Env;
  catalog: CatalogService;
  coupons: CouponService;
  orders: OrderRepository;
  gateway: PaymentGateway;
  onOrderPaid: OnOrderPaid;
  logger: FastifyBaseLogger;
}

const PIX_TTL_SECONDS = 30 * 60; // 30 min
const BOLETO_TTL_SECONDS = 3 * 24 * 60 * 60; // 3 dias

export class CheckoutService {
  constructor(private readonly deps: CheckoutServiceDeps) {}

  /**
   * Cria a sessão de checkout:
   *  1. valida o pack (existe e é pago)
   *  2. RECALCULA o preço no servidor (subtotal do catálogo + cupom validado)
   *  3. cria o pedido (status pending)
   *  4. abre a cobrança no gateway (mock hoje / PradaPay amanhã)
   *  5. vincula o gateway, aplica o status inicial (e libera se já vier pago)
   */
  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutResult> {
    const pack = this.deps.catalog.requirePurchasable(input.packId);

    // ── preço fechado no servidor (nunca confia no cliente) ──
    const pricing = this.deps.coupons.price(pack.priceCents, input.couponCode);

    const installments =
      input.paymentMethod === 'card'
        ? resolveInstallment(pricing.totalCents, input.installments ?? 1).number
        : 1;

    const now = new Date().toISOString();
    const order = new Order({
      id: newId('ord'),
      packId: pack.id,
      packTitle: pack.title,
      method: input.paymentMethod,
      customer: {
        email: input.customer.email,
        taxId: input.customer.cpf,
        ...(input.customer.name ? { name: input.customer.name } : {}),
      },
      subtotalCents: pricing.subtotalCents,
      discountCents: pricing.discountCents,
      totalCents: pricing.totalCents,
      couponCode: pricing.coupon?.code ?? null,
      installments,
      status: 'pending',
      gatewayName: this.deps.gateway.name,
      gatewayId: null,
      createdAt: now,
      updatedAt: now,
      paidAt: null,
    });
    await this.deps.orders.save(order);

    // ── abre a cobrança no gateway ──
    const returnUrl = `${this.deps.env.APP_BASE_URL}/compra/retorno?order=${order.id}`;
    const webhookUrl = `${this.deps.env.API_PUBLIC_URL}/api/webhooks/${this.deps.gateway.name}`;

    const charge = await this.deps.gateway.createCharge({
      orderId: order.id,
      amountCents: pricing.totalCents,
      method: input.paymentMethod,
      customer: {
        email: input.customer.email,
        taxId: input.customer.cpf,
        ...(input.customer.name ? { name: input.customer.name } : {}),
      },
      description: `CULTO · ${pack.title}`,
      ...(input.paymentMethod === 'card'
        ? { installments, ...(input.cardToken ? { cardToken: input.cardToken } : {}) }
        : {}),
      webhookUrl,
      returnUrl,
      expiresInSeconds:
        input.paymentMethod === 'pix'
          ? PIX_TTL_SECONDS
          : input.paymentMethod === 'boleto'
            ? BOLETO_TTL_SECONDS
            : undefined,
      metadata: { orderId: order.id, packId: pack.id },
    });

    order.linkGateway(charge.gatewayId);
    const becamePaid = order.applyStatus(charge.status);
    await this.deps.orders.save(order);

    if (becamePaid && order.status === 'paid') {
      await this.fireOnPaid(order);
    }

    return {
      order: orderToView(order),
      payment: chargeToPaymentView(charge, order.status),
      returnUrl,
    };
  }

  /**
   * Estado da sessão (usado pela página de retorno e pelo polling do Pix).
   * Faz best-effort de sincronizar com o gateway se o pedido ainda não estiver
   * num estado terminal — assim o status reflete a realidade mesmo que o
   * webhook ainda não tenha chegado.
   */
  async getStatus(orderId: string): Promise<CheckoutStatusResult> {
    const order = await this.deps.orders.findById(orderId);
    if (!order) throw new OrderNotFoundError(orderId);

    if (!isTerminal(order.status) && order.gatewayId) {
      try {
        const charge = await this.deps.gateway.getCharge(order.gatewayId);
        const becamePaid = order.applyStatus(charge.status);
        await this.deps.orders.save(order);
        if (becamePaid && order.status === 'paid') {
          await this.fireOnPaid(order);
        }
      } catch (err) {
        // Gateway indisponível no polling não deve quebrar a página: devolve o
        // último estado conhecido.
        this.deps.logger.warn({ err, orderId }, 'falha ao sincronizar status com o gateway');
      }
    }

    return { order: orderToView(order) };
  }

  private async fireOnPaid(order: Order): Promise<void> {
    try {
      await this.deps.onOrderPaid(order);
    } catch (err) {
      // Não queremos que um erro no efeito (entitlement/e-mail) derrube a
      // resposta da compra; loga e segue. Reprocessamento fica pro webhook.
      this.deps.logger.error({ err, orderId: order.id }, 'onOrderPaid falhou');
    }
  }
}

// ── mappers (entidade -> view serializável) ─────────────────────────────────

function pricingFromOrder(o: ReturnType<Order['snapshot']>): PricingBreakdown {
  const coupon = o.couponCode ? findCoupon(o.couponCode) : undefined;
  return {
    subtotalCents: o.subtotalCents,
    discountCents: o.discountCents,
    totalCents: o.totalCents,
    coupon: coupon ? { code: coupon.code, label: coupon.label } : null,
    formatted: {
      subtotal: formatBRL(o.subtotalCents),
      discount: formatBRL(o.discountCents),
      total: formatBRL(o.totalCents),
    },
  };
}

function orderToView(order: Order): OrderView {
  const o = order.snapshot();
  return {
    id: o.id,
    status: o.status,
    packId: o.packId,
    packTitle: o.packTitle,
    method: o.method,
    installments: o.installments,
    pricing: pricingFromOrder(o),
    createdAt: o.createdAt,
    paidAt: o.paidAt,
  };
}

function chargeToPaymentView(charge: ChargeResult, status: PaymentView['status']): PaymentView {
  const view: PaymentView = { method: charge.method, status };
  if (charge.pix) {
    view.pix = {
      copyPaste: charge.pix.copyPaste,
      ...(charge.pix.qrCodeImage ? { qrCodeImage: charge.pix.qrCodeImage } : {}),
      expiresAt: charge.pix.expiresAt,
    };
  }
  if (charge.boleto) {
    view.boleto = {
      line: charge.boleto.line,
      barcode: charge.boleto.barcode,
      ...(charge.boleto.pdfUrl ? { pdfUrl: charge.boleto.pdfUrl } : {}),
      expiresAt: charge.boleto.expiresAt,
    };
  }
  if (charge.card) {
    view.card = {
      ...(charge.card.brand ? { brand: charge.card.brand } : {}),
      ...(charge.card.last4 ? { last4: charge.card.last4 } : {}),
      ...(charge.card.installments ? { installments: charge.card.installments } : {}),
    };
  }
  return view;
}
