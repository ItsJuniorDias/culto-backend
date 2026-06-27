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
 *  ADAPTER PradaPay  —  ALINHADO À DOC OFICIAL
 *  (https://web.pradapay.com/developers)
 * ════════════════════════════════════════════════════════════════════════
 *
 * Contrato real da PradaPay:
 *   - Base:                 https://api.pradapay.com
 *   - Cobrança (Pix/Cartão/Boleto):  POST /v1/gateway/
 *   - Consulta de status:            POST /v1/webhook/   { idtransaction } -> { status }
 *   - Auth: a api-key vai NO CORPO JSON (campo "api-key"), NÃO em header.
 *   - amount em REAIS decimal (ex.: 1.50), NÃO em centavos.
 *   - client.userPhone é OBRIGATÓRIO (além de name/email/document).
 *   - Pix é o método PADRÃO; cartão usa forma_pagamento:"cartao", boleto "boleto".
 *   - Sucesso: { status:"success", idTransaction, paymentCode, paymentCodeBase64, ... }
 *       (o "status" aqui é da REQUISIÇÃO; o status do PAGAMENTO vem do /v1/webhook/.)
 *   - Erro: pode vir HTTP 200 com { status:"error", message } — checamos o corpo.
 *   - Webhook SEM assinatura (a doc não define) — a confirmação confiável é por
 *     POLLING (getStatus -> getCharge -> /v1/webhook/).
 */

export interface PradaPayConfig {
  apiKey: string;
  baseUrl: string;
  /** Não usado pela PradaPay (sem assinatura de webhook). Mantido por compat. */
  webhookSecret?: string;
}

/** Status do PAGAMENTO conforme a PradaPay (FAQ + respostas reais). */
function normalizeStatus(raw: string): PaymentStatus {
  const s = (raw || '').toUpperCase();
  if (['PAID_OUT', 'PAID', 'PAGO', 'APPROVED', 'SUCCESS', 'COMPLETED'].includes(s)) return 'paid';
  if (['WAITING_FOR_APPROVAL', 'PENDING', 'WAITING', 'CREATED'].includes(s)) return 'pending';
  if (['PROCESSING', 'IN_PROCESS', 'IN_ANALYSIS', 'AUTHORIZED'].includes(s)) return 'processing';
  if (['DECLINED', 'REFUSED', 'FAILED', 'REJECTED', 'ERROR'].includes(s)) return 'failed';
  if (['REFUNDED', 'CHARGEBACK', 'REVERSED'].includes(s)) return 'refunded';
  if (['EXPIRED'].includes(s)) return 'expired';
  if (['CANCELED', 'CANCELLED', 'VOIDED'].includes(s)) return 'canceled';
  return 'pending'; // desconhecidos => pendente
}

/** Tenta achar um valor em várias chaves possíveis. */
function pick<T = unknown>(obj: Record<string, unknown> | undefined, keys: string[]): T | undefined {
  if (!obj) return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k] as T;
  }
  return undefined;
}

/** CPF (dígitos) -> 000.000.000-00 (formato que a doc usa). */
function formatCPF(value: string): string {
  const n = (value || '').replace(/\D/g, '').slice(0, 11);
  if (n.length !== 11) return value;
  return n.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
}

/** Telefone BR (dígitos) -> (00) 00000-0000 / (00) 0000-0000. */
function formatPhone(value: string): string {
  const n = (value || '').replace(/\D/g, '');
  if (n.length === 11) return n.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3');
  if (n.length === 10) return n.replace(/(\d{2})(\d{4})(\d{4})/, '($1) $2-$3');
  return value;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export class PradaPayGateway implements PaymentGateway {
  readonly name = 'pradapay';
  private readonly config: PradaPayConfig;

  constructor(config: PradaPayConfig) {
    if (!config.apiKey) {
      throw new GatewayNotConfiguredError('PRADAPAY_API_KEY ausente.');
    }
    this.config = config;
  }

  async createCharge(input: CreateChargeInput): Promise<ChargeResult> {
    if (!input.customer.name) {
      throw new GatewayError('PradaPay exige o nome do cliente (client.name).');
    }
    if (!input.customer.phone) {
      throw new GatewayError('PradaPay exige o telefone do cliente (client.userPhone).');
    }

    const body: Record<string, unknown> = {
      requestNumber: input.orderId, // volta como referência -> achamos o pedido
      amount: round2(input.amountCents / 100), // REAIS decimal (não centavos)
      'api-key': this.config.apiKey, // auth vai no corpo
      postback: input.webhookUrl, // callback de notificação
      client: {
        name: input.customer.name,
        document: formatCPF(input.customer.taxId),
        email: input.customer.email,
        userPhone: formatPhone(input.customer.phone),
      },
    };

    if (input.method === 'boleto') {
      body.forma_pagamento = 'boleto';
    } else if (input.method === 'card') {
      // ⚠ A API de cartão da PradaPay espera os dados CRUS do cartão
      // (card.numero/cvv/...). Este backend é tokenizado (PCI) e NÃO recebe o
      // PAN cru, então o fluxo de CARTÃO via PradaPay precisa de uma decisão à
      // parte (checkout/SDK da PradaPay no front). PIX e BOLETO funcionam aqui.
      body.forma_pagamento = 'cartao';
      body.parcela = input.installments ?? 1;
    }
    // Pix: é o padrão da PradaPay — não envia forma_pagamento.

    const data = await this.request<Record<string, unknown>>('POST', '/v1/gateway/', body);
    return this.toChargeResult(input.method, input.amountCents, data);
  }

  /** Consulta o status no gateway (usado pelo polling da página de retorno). */
  async getCharge(gatewayId: string): Promise<ChargeResult> {
    const data = await this.request<Record<string, unknown>>('POST', '/v1/webhook/', {
      idtransaction: gatewayId,
    });
    const statusRaw = String(pick(data, ['status', 'payment_status']) ?? 'pending');
    // O endpoint de status só devolve o status; method/amount não são usados
    // pelo getStatus (apenas charge.status é aplicado ao pedido).
    return {
      gatewayId,
      status: normalizeStatus(statusRaw),
      method: 'pix',
      amountCents: 0,
      raw: data,
    };
  }

  /**
   * Webhook de ENTRADA (postback). A doc da PradaPay não define assinatura nem
   * o formato exato do corpo, então NÃO verificamos assinatura e extraímos os
   * campos de forma tolerante. A confirmação confiável é por POLLING (acima),
   * então este caminho é um bônus.
   */
  parseWebhook(req: RawWebhookRequest): WebhookEvent {
    const raw = typeof req.rawBody === 'string' ? req.rawBody : req.rawBody.toString('utf8');

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new GatewayError('Webhook da PradaPay com JSON inválido.');
    }

    const tx = pick<Record<string, unknown>>(payload, ['data', 'transaction']) ?? payload;
    const gatewayId = String(
      pick(tx, ['idtransaction', 'idTransaction', 'id', 'transaction_id']) ?? '',
    );
    const orderId = pick<string>(tx, ['requestNumber', 'external_reference', 'reference']);
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
        headers: { 'Content-Type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (cause) {
      throw new GatewayError('Não foi possível conectar à PradaPay.', { cause: String(cause) });
    }

    const text = await res.text();
    const json = text ? safeJson(text) : undefined;
    const asObj = json && typeof json === 'object' ? (json as Record<string, unknown>) : undefined;

    // A PradaPay pode devolver HTTP 200 com { status: "error", message }.
    const apiError = asObj && String(asObj.status ?? '').toLowerCase() === 'error';
    if (!res.ok || apiError) {
      const message = asObj?.message ? String(asObj.message) : `PradaPay respondeu ${res.status}.`;
      throw new GatewayError(message, { status: res.status, body: json ?? text });
    }
    return json as T;
  }

  private toChargeResult(
    method: PaymentMethod,
    amountCents: number,
    data: Record<string, unknown>,
  ): ChargeResult {
    const gatewayId = String(pick(data, ['idTransaction', 'idtransaction', 'id']) ?? '');

    const result: ChargeResult = {
      gatewayId,
      // Na criação, o Pix ainda não foi pago. O "status":"success" da resposta é
      // da REQUISIÇÃO, não do pagamento — o status real vem do polling.
      status: 'pending',
      method,
      amountCents,
      raw: data,
    };

    if (method === 'pix') {
      result.pix = {
        copyPaste: String(pick(data, ['paymentCode', 'copy_paste', 'emv']) ?? ''),
        ...(pick(data, ['paymentCodeBase64', 'qr_code_base64'])
          ? { qrCodeImage: toDataUrl(String(pick(data, ['paymentCodeBase64', 'qr_code_base64']))) }
          : {}),
        expiresAt: new Date(Date.now() + 1800_000).toISOString(),
      };
    }

    if (method === 'boleto') {
      const barcode = String(pick(data, ['barcode']) ?? '');
      result.boleto = {
        line: barcode,
        barcode,
        ...(pick(data, ['pdf_url', 'url']) ? { pdfUrl: String(pick(data, ['pdf_url', 'url'])) } : {}),
        expiresAt: new Date(Date.now() + 3 * 86400_000).toISOString(),
      };
    }

    if (method === 'card') {
      const retorno = pick<string>(data, ['retorno_cartao']);
      if (retorno) result.status = normalizeStatus(retorno);
    }

    return result;
  }
}

/** A doc devolve só a string base64 do PNG; o front espera algo exibível. */
function toDataUrl(base64: string): string {
  return base64.startsWith('data:') ? base64 : `data:image/png;base64,${base64}`;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
