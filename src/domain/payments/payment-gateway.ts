import type { PaymentMethod, PaymentStatus } from './payment.types.js';

/**
 * PORTA do gateway de pagamento (padrão Ports & Adapters / Hexagonal).
 *
 * O resto do app depende SÓ desta interface. Hoje roda o MockGateway; quando
 * a PradaPay entrar, é só escrever o adapter PradaPayGateway implementando
 * isto e trocar uma variável de ambiente (PAYMENT_PROVIDER). Nenhum service
 * de negócio muda.
 */

export interface GatewayCustomer {
  name?: string | undefined;
  email: string;
  /** CPF só com dígitos (11). */
  taxId: string;
  /**
   * Telefone (dígitos, com DDD). Opcional na porta, mas OBRIGATÓRIO na
   * PradaPay — o adapter dela falha cedo e com mensagem clara se vier vazio.
   */
  phone?: string | undefined;
}

export interface CreateChargeInput {
  /** Nosso id de pedido — mandado pro gateway como referência externa, pra
   *  voltar no webhook e a gente saber qual pedido atualizar. */
  orderId: string;
  amountCents: number;
  method: PaymentMethod;
  customer: GatewayCustomer;
  description: string;

  /** Cartão: número de parcelas. */
  installments?: number | undefined;
  /**
   * Cartão: TOKEN do cartão (gerado no cliente via SDK/tokenização do gateway).
   * PCI-DSS: o PAN/CVV crus NUNCA passam por este backend. Veja o README.
   */
  cardToken?: string | undefined;

  /**
   * Cartão (PradaPay): dados CRUS do cartão. A API da PradaPay NÃO tem fluxo de
   * tokenização — o cartão é enviado por aqui. ATENÇÃO PCI-DSS: usar isto coloca
   * o PAN/CVV dentro do escopo do seu servidor. Só é aceito quando
   * PRADAPAY_ENABLE_CARD=true. O fluxo recomendado continua sendo Pix.
   */
  cardRaw?:
    | {
        holder: string;
        number: string;
        /** Mês de validade, 2 dígitos (ex.: "12"). */
        expMonth: string;
        /** Ano de validade, 2 dígitos (ex.: "26"). */
        expYear: string;
        cvv: string;
      }
    | undefined;

  /** URL que o gateway chama (server-to-server) quando o status muda. */
  webhookUrl: string;
  /** URL pra onde mandar o cliente depois do pagamento. */
  returnUrl: string;

  /** Pix/boleto: validade em segundos. */
  expiresInSeconds?: number | undefined;

  metadata?: Record<string, string> | undefined;
}

/** Dados pra exibir o Pix (QR + copia-e-cola). */
export interface PixDetails {
  /** Imagem do QR (data URL ou URL) — opcional. */
  qrCodeImage?: string;
  /** Payload "copia e cola" (BR Code / EMV). */
  copyPaste: string;
  expiresAt: string; // ISO
}

/** Dados pra exibir o boleto. */
export interface BoletoDetails {
  /** Linha digitável. */
  line: string;
  barcode: string;
  pdfUrl?: string;
  expiresAt: string; // ISO
}

export interface CardDetails {
  brand?: string;
  last4?: string;
  installments?: number;
}

/** Resultado normalizado de uma cobrança. */
export interface ChargeResult {
  /** Id da transação NO gateway. */
  gatewayId: string;
  status: PaymentStatus;
  method: PaymentMethod;
  amountCents: number;
  pix?: PixDetails;
  boleto?: BoletoDetails;
  card?: CardDetails;
  /**
   * Fluxo "redirect": URL externa pra concluir o pagamento (cartão/boleto em
   * alguns gateways, como a PradaPay). Quando presente, o front redireciona.
   */
  redirectUrl?: string;
  /** Payload original do gateway — guardado pra auditoria/depuração. */
  raw?: unknown;
}

/** Requisição crua de webhook, pra o adapter validar assinatura. */
export interface RawWebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  /** Corpo CRU (Buffer/string), necessário pra conferir a assinatura. */
  rawBody: Buffer | string;
}

/** Evento de webhook já validado e normalizado. */
export interface WebhookEvent {
  /** Id da transação no gateway. */
  gatewayId: string;
  /** Nosso orderId, se o gateway devolveu a referência externa. */
  orderId?: string;
  status: PaymentStatus;
  /** Tipo bruto do evento, pra log. */
  type: string;
  raw: unknown;
}

export interface PaymentGateway {
  /** Nome do provider ("mock", "pradapay") — pra logs. */
  readonly name: string;

  /** Cria a cobrança e devolve o resultado normalizado. */
  createCharge(input: CreateChargeInput): Promise<ChargeResult>;

  /** Consulta o estado atual da cobrança no gateway. */
  getCharge(gatewayId: string): Promise<ChargeResult>;

  /**
   * Valida/normaliza o webhook. Deve LANÇAR WebhookSignatureError se a
   * autenticidade não puder ser confirmada.
   *
   * É assíncrono porque nem todo gateway assina o callback: quando não há
   * assinatura (caso da PradaPay), a forma segura de confirmar é RE-CONSULTAR
   * o status na API do provedor (server-to-server) — e isso é I/O.
   */
  parseWebhook(req: RawWebhookRequest): Promise<WebhookEvent>;
}
