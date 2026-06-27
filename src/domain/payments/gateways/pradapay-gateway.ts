import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  ChargeResult,
  CreateChargeInput,
  PaymentGateway,
  RawWebhookRequest,
  WebhookEvent,
} from '../payment-gateway.js';
import type { PaymentMethod, PaymentStatus } from '../payment.types.js';
import { GatewayError, GatewayNotConfiguredError, WebhookSignatureError } from '../../../shared/errors.js';

/**
 * ════════════════════════════════════════════════════════════════════════
 *  ADAPTER PradaPay  —  STUB PRONTO PRA PLUGAR
 * ════════════════════════════════════════════════════════════════════════
 *
 * A PradaPay é um gateway REST + webhook + API key, focado em Pix (mesmo
 * padrão de PixToPay/Efí/Pagar.me). A documentação oficial fica atrás de
 * login, então os NOMES EXATOS de campos/endpoints/headers abaixo são o
 * padrão de mercado e estão marcados com  ←★ AJUSTAR  onde você confirma na
 * doc da PradaPay. Em geral é trocar 3–4 strings e está no ar.
 *
 * O que JÁ está pronto e correto, independente da doc:
 *   - estrutura do adapter (implementa a porta PaymentGateway)
 *   - chamada HTTP com fetch nativo + tratamento de erro
 *   - verificação de assinatura HMAC do webhook (timing-safe)
 *   - normalização de status pro vocabulário da casa
 */

export interface PradaPayConfig {
  apiKey: string;
  baseUrl: string;
  webhookSecret: string;
  /** Header onde a PradaPay manda a assinatura do webhook.  ←★ AJUSTAR */
  webhookSignatureHeader?: string;
}

// ←★ AJUSTAR: como a PradaPay nomeia os métodos no request.
const METHOD_MAP: Record<PaymentMethod, string> = {
  pix: 'pix',
  card: 'credit_card',
  boleto: 'boleto',
};

/**
 * ←★ AJUSTAR: mapeia o status da PradaPay -> status normalizado da casa.
 * Cobrimos os termos mais comuns; acrescente os que aparecerem na doc.
 */
function normalizeStatus(raw: string): PaymentStatus {
  const s = (raw || '').toLowerCase();
  if (['paid', 'approved', 'confirmed', 'completed', 'settled', 'succeeded'].includes(s)) return 'paid';
  if (['processing', 'in_process', 'in_analysis', 'authorized'].includes(s)) return 'processing';
  if (['expired'].includes(s)) return 'expired';
  if (['refunded', 'chargeback', 'reversed'].includes(s)) return 'refunded';
  if (['canceled', 'cancelled', 'voided'].includes(s)) return 'canceled';
  if (['failed', 'refused', 'declined', 'rejected', 'error'].includes(s)) return 'failed';
  return 'pending'; // created/waiting/pending e desconhecidos => pendente
}

/** Tenta achar um valor em várias chaves possíveis (a doc pode usar outra). */
function pick<T = unknown>(obj: Record<string, unknown>, keys: string[]): T | undefined {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k] as T;
  }
  return undefined;
}

export class PradaPayGateway implements PaymentGateway {
  readonly name = 'pradapay';
  private readonly config: PradaPayConfig;

  constructor(config: PradaPayConfig) {
    if (!config.apiKey) {
      throw new GatewayNotConfiguredError('PRADAPAY_API_KEY ausente.');
    }
    this.config = config;
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      // ←★ AJUSTAR: a PradaPay pode usar "Authorization: Bearer <key>",
      //    "x-api-key: <key>" ou "Authorization: <key>". Confirme na doc.
      Authorization: `Bearer ${this.config.apiKey}`,
    };
  }

  async createCharge(input: CreateChargeInput): Promise<ChargeResult> {
    // ←★ AJUSTAR: corpo da requisição conforme a doc da PradaPay.
    const body = {
      amount: input.amountCents, // ←★ muitos gateways BR usam CENTAVOS; confirme
      payment_method: METHOD_MAP[input.method],
      description: input.description,
      external_reference: input.orderId, // volta no webhook -> achamos o pedido
      postback_url: input.webhookUrl, // ←★ pode se chamar "webhook"/"notification_url"
      return_url: input.returnUrl,
      customer: {
        name: input.customer.name,
        email: input.customer.email,
        document: input.customer.taxId, // CPF (dígitos)  ←★ pode ser "tax_id"/"cpf"
      },
      ...(input.method === 'card'
        ? { installments: input.installments ?? 1, card_token: input.cardToken }
        : {}),
      ...(input.expiresInSeconds ? { expires_in: input.expiresInSeconds } : {}),
      metadata: input.metadata,
    };

    // ←★ AJUSTAR: endpoint de criação de cobrança.
    const data = await this.request<Record<string, unknown>>('POST', '/v1/transactions', body);
    return this.toChargeResult(input.method, input.amountCents, data);
  }

  async getCharge(gatewayId: string): Promise<ChargeResult> {
    // ←★ AJUSTAR: endpoint de consulta.
    const data = await this.request<Record<string, unknown>>(
      'GET',
      `/v1/transactions/${encodeURIComponent(gatewayId)}`,
    );
    const method = (pick<string>(data, ['payment_method', 'method']) ?? 'pix') as PaymentMethod;
    const amount = Number(pick(data, ['amount', 'amount_cents']) ?? 0);
    return this.toChargeResult(method in METHOD_MAP ? method : 'pix', amount, data);
  }

  parseWebhook(req: RawWebhookRequest): WebhookEvent {
    const raw = typeof req.rawBody === 'string' ? req.rawBody : req.rawBody.toString('utf8');

    // ←★ AJUSTAR: nome do header de assinatura.
    const headerName = (this.config.webhookSignatureHeader ?? 'x-signature').toLowerCase();
    const headerValue = req.headers[headerName];
    const received = Array.isArray(headerValue) ? headerValue[0] : headerValue;

    // ←★ AJUSTAR: algumas casas assinam o corpo cru com HMAC-SHA256 hex;
    //    outras mandam um token fixo. Aqui está o caso HMAC (o mais comum).
    const expected = createHmac('sha256', this.config.webhookSecret).update(raw).digest('hex');
    if (!received || !safeEqual(received, expected)) {
      throw new WebhookSignatureError();
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new GatewayError('Webhook da PradaPay com JSON inválido.');
    }

    // O payload pode vir "achatado" ou aninhado em { data: {...} } / { transaction: {...} }.
    const tx = (pick<Record<string, unknown>>(payload, ['data', 'transaction']) ?? payload);
    const gatewayId = String(pick(tx, ['id', 'transaction_id']) ?? '');
    const orderId = pick<string>(tx, ['external_reference', 'reference']);
    const statusRaw = String(pick(tx, ['status', 'payment_status']) ?? '');

    if (!gatewayId) throw new GatewayError('Webhook da PradaPay sem id da transação.');

    return {
      gatewayId,
      ...(orderId ? { orderId } : {}),
      status: normalizeStatus(statusRaw),
      type: String(pick(payload, ['event', 'type']) ?? 'transaction.updated'),
      raw: payload,
    };
  }

  // ── infra HTTP ──────────────────────────────────────────────────────────

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.config.baseUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: this.headers(),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (cause) {
      throw new GatewayError('Não foi possível conectar à PradaPay.', { cause: String(cause) });
    }

    const text = await res.text();
    const json = text ? safeJson(text) : undefined;

    if (!res.ok) {
      throw new GatewayError(`PradaPay respondeu ${res.status}.`, { status: res.status, body: json ?? text });
    }
    return json as T;
  }

  private toChargeResult(
    method: PaymentMethod,
    amountCents: number,
    data: Record<string, unknown>,
  ): ChargeResult {
    const gatewayId = String(pick(data, ['id', 'transaction_id']) ?? '');
    const statusRaw = String(pick(data, ['status', 'payment_status']) ?? 'pending');

    const result: ChargeResult = {
      gatewayId,
      status: normalizeStatus(statusRaw),
      method,
      amountCents,
      raw: data,
    };

    // ←★ AJUSTAR: caminhos do QR/copia-e-cola e do boleto conforme a doc.
    const pix = pick<Record<string, unknown>>(data, ['pix', 'qr_code', 'qrcode']);
    if (method === 'pix' && pix) {
      result.pix = {
        copyPaste: String(pick(pix, ['qr_code', 'copy_paste', 'emv', 'payload']) ?? ''),
        ...(pick(pix, ['qr_code_image', 'image_url', 'qr_code_base64'])
          ? { qrCodeImage: String(pick(pix, ['qr_code_image', 'image_url', 'qr_code_base64'])) }
          : {}),
        expiresAt: String(pick(pix, ['expires_at', 'expiration']) ?? new Date(Date.now() + 1800_000).toISOString()),
      };
    }

    const boleto = pick<Record<string, unknown>>(data, ['boleto', 'bank_slip']);
    if (method === 'boleto' && boleto) {
      result.boleto = {
        line: String(pick(boleto, ['line', 'digitable_line', 'barcode']) ?? ''),
        barcode: String(pick(boleto, ['barcode', 'bar_code']) ?? ''),
        ...(pick(boleto, ['pdf_url', 'url']) ? { pdfUrl: String(pick(boleto, ['pdf_url', 'url'])) } : {}),
        expiresAt: String(pick(boleto, ['expires_at', 'due_date']) ?? new Date(Date.now() + 3 * 86400_000).toISOString()),
      };
    }

    return result;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
