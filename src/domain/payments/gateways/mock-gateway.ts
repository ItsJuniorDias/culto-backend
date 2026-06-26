import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  ChargeResult,
  CreateChargeInput,
  PaymentGateway,
  RawWebhookRequest,
  WebhookEvent,
} from '../payment-gateway.js';
import type { PaymentMethod, PaymentStatus } from '../payment.types.js';
import { newId } from '../../../shared/id.js';
import { GatewayError, WebhookSignatureError } from '../../../shared/errors.js';

/**
 * Gateway MOCK. Faz o fluxo inteiro rodar SEM provedor real, espelhando o
 * checkout mockado do front: cartão e Pix aprovam na hora (configurável),
 * boleto fica pendente. Gera QR/linha digitável só pra aparência.
 *
 * O caminho de webhook é REAL (assina e valida HMAC), então quando a PradaPay
 * entrar, nada na borda muda — só o adapter.
 */

export const MOCK_WEBHOOK_SIGNATURE_HEADER = 'x-mock-signature';

export interface MockGatewayConfig {
  autoApprove: Record<PaymentMethod, boolean>;
  webhookSecret: string;
}

/** Assina um corpo de webhook como o mock espera (usado pela rota de simulação). */
export function signMockWebhook(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

function buildPixCode(orderId: string, amountCents: number): string {
  const amount = (amountCents / 100).toFixed(2);
  return `00020126580014br.gov.bcb.pix0136culto-${orderId}520400005303986540${amount}5802BR5913CULTO ASSETS6009SAO PAULO62070503***6304E2CA`;
}

function buildBoletoLine(amountCents: number): string {
  const v = String(amountCents).padStart(10, '0');
  return `34191.79001 ${v.slice(0, 5)}.510047 91020.150008 8 ${Math.floor(Date.now() / 1e7)}`;
}

export class MockGateway implements PaymentGateway {
  readonly name = 'mock';
  private readonly config: MockGatewayConfig;
  /** "Banco de dados" do gateway fake, pra getCharge funcionar. */
  private readonly charges = new Map<string, ChargeResult>();

  constructor(config: MockGatewayConfig) {
    this.config = config;
  }

  async createCharge(input: CreateChargeInput): Promise<ChargeResult> {
    const gatewayId = newId('mock');
    const approved = this.config.autoApprove[input.method];

    const status: PaymentStatus =
      input.method === 'card'
        ? approved
          ? 'paid'
          : 'processing'
        : approved
          ? 'paid'
          : 'pending';

    const expiresAt = new Date(
      Date.now() + (input.expiresInSeconds ?? 1800) * 1000,
    ).toISOString();

    const result: ChargeResult = {
      gatewayId,
      status,
      method: input.method,
      amountCents: input.amountCents,
      raw: { simulated: true, provider: 'mock' },
    };

    if (input.method === 'pix') {
      result.pix = {
        copyPaste: buildPixCode(input.orderId, input.amountCents),
        expiresAt,
      };
    } else if (input.method === 'boleto') {
      result.boleto = {
        line: buildBoletoLine(input.amountCents),
        barcode: buildBoletoLine(input.amountCents).replace(/\D/g, ''),
        expiresAt,
      };
    } else {
      result.card = {
        installments: input.installments ?? 1,
        ...(input.cardToken ? { last4: input.cardToken.slice(-4) } : {}),
      };
    }

    this.charges.set(gatewayId, result);
    return result;
  }

  async getCharge(gatewayId: string): Promise<ChargeResult> {
    const charge = this.charges.get(gatewayId);
    if (!charge) {
      throw new GatewayError(`Cobrança "${gatewayId}" não existe no gateway mock.`);
    }
    return charge;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async parseWebhook(req: RawWebhookRequest): Promise<WebhookEvent> {
    const raw = typeof req.rawBody === 'string' ? req.rawBody : req.rawBody.toString('utf8');

    const headerValue = req.headers[MOCK_WEBHOOK_SIGNATURE_HEADER];
    const received = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    const expected = signMockWebhook(this.config.webhookSecret, raw);

    if (!received || !safeEqual(received, expected)) {
      throw new WebhookSignatureError();
    }

    let body: { gatewayId?: string; orderId?: string; status?: string; type?: string };
    try {
      body = JSON.parse(raw);
    } catch {
      throw new GatewayError('Webhook mock com JSON inválido.');
    }

    if (!body.gatewayId || !body.status) {
      throw new GatewayError('Webhook mock sem gatewayId/status.');
    }

    // Atualiza o "banco" interno pra getCharge refletir o novo status.
    const existing = this.charges.get(body.gatewayId);
    if (existing) existing.status = body.status as PaymentStatus;

    return {
      gatewayId: body.gatewayId,
      ...(body.orderId ? { orderId: body.orderId } : {}),
      status: body.status as PaymentStatus,
      type: body.type ?? 'payment.updated',
      raw: body,
    };
  }
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
