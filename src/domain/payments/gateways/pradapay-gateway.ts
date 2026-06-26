import type {
  ChargeResult,
  CreateChargeInput,
  PaymentGateway,
  RawWebhookRequest,
  WebhookEvent,
} from '../payment-gateway.js';
import type { PaymentMethod, PaymentStatus } from '../payment.types.js';
import { GatewayError, GatewayNotConfiguredError } from '../../../shared/errors.js';

/**
 * ════════════════════════════════════════════════════════════════════════
 *  ADAPTER PradaPay  —  integrado contra a API REAL (api.pradapay.com)
 * ════════════════════════════════════════════════════════════════════════
 *
 * Contrato confirmado na doc oficial (web.pradapay.com/developers). A PradaPay
 * NÃO segue o padrão Bearer/REST clássico; as particularidades que moldam este
 * adapter:
 *
 *   • AUTENTICAÇÃO no CORPO. A api-key vai no JSON (campo "api-key"), não num
 *     header Authorization.
 *   • ENDPOINT ÚNICO. Pix, cartão e boleto vão todos pra POST /v1/gateway/; o
 *     método é escolhido por "forma_pagamento" (Pix omite; "cartao"; "boleto").
 *   • VALOR EM REAIS. "amount" é decimal em reais (1.50), não centavos. Como a
 *     casa trabalha em centavos, convertemos só na borda.
 *   • TELEFONE OBRIGATÓRIO. client.userPhone é exigido — falhamos cedo e claro
 *     se não vier.
 *   • WEBHOOK SEM ASSINATURA. O postback não é assinado nem tem formato fixo
 *     documentado. Em vez de confiar no corpo, RE-CONSULTAMOS o status na API
 *     (POST /v1/webhook/) — assim um POST forjado não engana o sistema.
 *   • CARTÃO COM PAN CRU. A PradaPay não tem tokenização; o cartão trafega em
 *     claro. Por isso o fluxo de cartão é OPT-IN (enableCard) — leia o README
 *     sobre escopo PCI-DSS. O caminho recomendado é Pix.
 *
 * Status da PradaPay: PAID_OUT (pago), WAITING_FOR_APPROVAL (pendente),
 * DECLINED (recusado), além de retorno_cartao ("PAID") e cashout ("pago"/
 * "refunded"). Tudo é traduzido pro vocabulário normalizado da casa.
 */

export interface PradaPayConfig {
  apiKey: string;
  baseUrl: string;
  /** Habilita cartão (PAN cru). PCI-DSS: veja o README. Padrão: false. */
  enableCard?: boolean;
}

/** Traduz o status da PradaPay -> status normalizado da casa. */
function normalizeStatus(raw: string): PaymentStatus {
  const s = (raw ?? '').toString().trim().toUpperCase();
  if (['PAID_OUT', 'PAID', 'PAGO', 'APPROVED', 'COMPLETED', 'CONFIRMED', 'SETTLED'].includes(s)) return 'paid';
  if (['PROCESSING', 'IN_PROCESS', 'IN_ANALYSIS', 'AUTHORIZED'].includes(s)) return 'processing';
  if (['WAITING_FOR_APPROVAL', 'WAITING', 'PENDING', 'PENDENTE', 'CREATED'].includes(s)) return 'pending';
  if (['DECLINED', 'REFUSED', 'RECUSADO', 'DENIED', 'REJECTED', 'ERROR', 'FAILED'].includes(s)) return 'failed';
  if (['REFUNDED', 'ESTORNADO', 'CHARGEBACK', 'REVERSED'].includes(s)) return 'refunded';
  if (['CANCELED', 'CANCELLED', 'VOIDED'].includes(s)) return 'canceled';
  if (['EXPIRED', 'EXPIRADO'].includes(s)) return 'expired';
  return 'pending'; // desconhecidos => pendente (não derruba a transação)
}

/** Tenta achar um valor em várias chaves possíveis (o payload pode variar). */
function pick<T = unknown>(obj: Record<string, unknown>, keys: string[]): T | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null) return v as T;
  }
  return undefined;
}

/** Centavos inteiros -> reais decimais com 2 casas (formato da PradaPay). */
function centsToAmount(cents: number): number {
  return Number((Math.round(cents) / 100).toFixed(2));
}

function toDataUrl(base64: string): string {
  return base64.startsWith('data:') ? base64 : `data:image/png;base64,${base64}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export class PradaPayGateway implements PaymentGateway {
  readonly name = 'pradapay';
  private readonly config: Required<PradaPayConfig>;

  constructor(config: PradaPayConfig) {
    if (!config.apiKey) {
      throw new GatewayNotConfiguredError('PRADAPAY_API_KEY ausente.');
    }
    this.config = {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl.replace(/\/+$/, ''),
      enableCard: config.enableCard ?? false,
    };
  }

  async createCharge(input: CreateChargeInput): Promise<ChargeResult> {
    if (!input.customer.phone) {
      throw new GatewayError(
        'A PradaPay exige telefone do cliente (client.userPhone). Envie customer.phone no checkout.',
      );
    }

    // Corpo base (Pix). A api-key vai AQUI, no corpo — não no header.
    const body: Record<string, unknown> = {
      requestNumber: input.orderId, // nossa referência; volta pra correlacionar
      amount: centsToAmount(input.amountCents), // PradaPay usa REAIS decimais
      'api-key': this.config.apiKey,
      postback: input.webhookUrl, // URL de callback (postback) do status
      client: {
        name: input.customer.name ?? '',
        document: input.customer.taxId, // CPF (dígitos)
        email: input.customer.email,
        userPhone: input.customer.phone, // OBRIGATÓRIO
      },
    };

    if (input.method === 'card') {
      if (!this.config.enableCard) {
        throw new GatewayError(
          'Cartão desabilitado para PradaPay. Defina PRADAPAY_ENABLE_CARD=true (atenção ao escopo PCI-DSS) para enviar PAN cru.',
        );
      }
      if (!input.cardRaw) {
        throw new GatewayError('Cartão na PradaPay exige os dados do cartão (cardRaw).');
      }
      body['forma_pagamento'] = 'cartao';
      body['parcela'] = input.installments ?? 1;
      body['card'] = {
        nome: input.cardRaw.holder,
        numero: input.cardRaw.number,
        mes: input.cardRaw.expMonth,
        ano: input.cardRaw.expYear,
        cvv: input.cardRaw.cvv,
      };
    } else if (input.method === 'boleto') {
      body['forma_pagamento'] = 'boleto';
    }
    // Pix: NÃO envia forma_pagamento (é o default do gateway).

    const data = await this.request('/v1/gateway/', body);

    // A PradaPay sinaliza falha de negócio no corpo (status: "error"), às vezes
    // com HTTP 200 — por isso conferimos o campo, não só o código.
    if (String(pick(data, ['status']) ?? '').toLowerCase() === 'error') {
      throw new GatewayError(
        `PradaPay recusou a cobrança: ${String(pick(data, ['message']) ?? 'erro desconhecido')}`,
        { body: data },
      );
    }

    return this.toChargeResult(input.method, input.amountCents, data);
  }

  async getCharge(gatewayId: string): Promise<ChargeResult> {
    // A PradaPay confirma status por POST /v1/webhook/ { idtransaction } -> { status }.
    const data = await this.request('/v1/webhook/', {
      idtransaction: gatewayId,
      'api-key': this.config.apiKey,
    });
    const statusRaw = String(pick(data, ['status', 'payment_status']) ?? 'pending');
    return {
      gatewayId,
      status: normalizeStatus(statusRaw),
      // O endpoint de status devolve só o status; método/valor são placeholders
      // (o polling em getStatus consome apenas .status).
      method: 'pix',
      amountCents: 0,
      raw: data,
    };
  }

  async parseWebhook(req: RawWebhookRequest): Promise<WebhookEvent> {
    const raw = typeof req.rawBody === 'string' ? req.rawBody : req.rawBody.toString('utf8');

    let payload: Record<string, unknown>;
    const parsed = raw ? safeJson(raw) : undefined;
    if (!isRecord(parsed)) {
      throw new GatewayError('Webhook da PradaPay com JSON inválido.');
    }
    payload = parsed;

    // O postback pode vir achatado ou aninhado em { data } / { transaction }.
    const tx = pick<Record<string, unknown>>(payload, ['data', 'transaction']) ?? payload;
    const gatewayId = String(
      pick(tx, ['idTransaction', 'idtransaction', 'transaction_id', 'id']) ?? '',
    );
    const orderId = pick<string>(tx, ['requestNumber', 'reference', 'external_reference']);

    if (!gatewayId) {
      throw new GatewayError('Webhook da PradaPay sem id da transação.');
    }

    // FONTE DA VERDADE: como o postback não é assinado, re-consultamos o status
    // server-to-server. Um POST forjado com "PAID_OUT" no corpo é ignorado.
    const confirmed = await this.getCharge(gatewayId);

    return {
      gatewayId,
      ...(orderId ? { orderId } : {}),
      status: confirmed.status,
      type: String(pick(payload, ['event', 'type', 'status']) ?? 'transaction.updated'),
      raw: payload,
    };
  }

  // ── infra HTTP ──────────────────────────────────────────────────────────

  private async request(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const url = `${this.config.baseUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw new GatewayError('Não foi possível conectar à PradaPay.', { cause: String(cause) });
    }

    const text = await res.text();
    const json = text ? safeJson(text) : undefined;

    if (!res.ok) {
      const message =
        (isRecord(json) && typeof json['message'] === 'string' && json['message']) ||
        `PradaPay respondeu ${res.status}.`;
      throw new GatewayError(message, { status: res.status, body: json ?? text });
    }
    if (!isRecord(json)) {
      throw new GatewayError('PradaPay devolveu resposta inesperada (não-JSON).', { body: text });
    }
    return json;
  }

  private toChargeResult(
    method: PaymentMethod,
    amountCents: number,
    data: Record<string, unknown>,
  ): ChargeResult {
    const gatewayId = String(
      pick(data, ['idTransaction', 'idtransaction', 'transaction_id', 'id']) ?? '',
    );

    const result: ChargeResult = {
      gatewayId,
      status: 'pending',
      method,
      amountCents, // mantemos em centavos no domínio; reais só foram pro request
      raw: data,
    };

    if (method === 'pix') {
      // Cobrança Pix recém-criada fica PENDENTE até o pagamento chegar (webhook).
      const copyPaste = String(pick(data, ['paymentCode', 'copy_paste', 'qr_code', 'emv']) ?? '');
      const base64 = pick<string>(data, ['paymentCodeBase64', 'qr_code_base64', 'qr_code_image']);
      result.pix = {
        copyPaste,
        ...(base64 ? { qrCodeImage: toDataUrl(base64) } : {}),
        expiresAt: String(
          pick(data, ['expires_at', 'expiration']) ?? new Date(Date.now() + 1800_000).toISOString(),
        ),
      };
    } else if (method === 'boleto') {
      // Boleto emitido: pendente até a compensação.
      const barcode = String(
        pick(data, ['barcode', 'bar_code', 'digitable_line', 'line']) ?? '',
      );
      result.boleto = {
        line: barcode,
        barcode: barcode.replace(/\D/g, ''),
        ...(pick(data, ['pdf_url', 'url']) ? { pdfUrl: String(pick(data, ['pdf_url', 'url'])) } : {}),
        expiresAt: String(
          pick(data, ['expires_at', 'due_date']) ?? new Date(Date.now() + 3 * 86400_000).toISOString(),
        ),
      };
      const redirect = pick<string>(data, ['paymentUrl', 'payment_url']);
      if (redirect) result.redirectUrl = redirect;
    } else {
      // Cartão: a adquirente pode aprovar na hora (retorno_cartao) ou exigir que
      // o cliente conclua num checkout externo (paymentUrl / fluxo redirect).
      const redirect = pick<string>(data, ['paymentUrl', 'payment_url']);
      let cardStatus = normalizeStatus(String(pick(data, ['retorno_cartao', 'card_status', 'status']) ?? ''));
      if (cardStatus !== 'paid' && cardStatus !== 'failed' && redirect) {
        cardStatus = 'processing'; // redirecionou: aguardando conclusão externa
      }
      result.status = cardStatus;
      result.card = {
        installments: Number(pick(data, ['parcela', 'installments']) ?? 1) || 1,
      };
      if (redirect) result.redirectUrl = redirect;
    }

    return result;
  }
}
