/**
 * Erros de aplicação tipados.
 *
 * Toda falha esperada vira um `AppError` com:
 *   - `code`: identificador estável pra máquina (o front pode reagir a ele)
 *   - `statusCode`: HTTP correspondente
 *   - `message`: texto pra humano (PT-BR)
 *   - `details`: payload opcional (ex.: erros de campo)
 *
 * O error-handler do Fastify (src/http/plugins/error-handler.ts) converte
 * AppError -> JSON. Qualquer erro NÃO-AppError vira 500 genérico, sem vazar
 * stack/detalhes internos pro cliente.
 */

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'PACK_NOT_FOUND'
  | 'PACK_NOT_PURCHASABLE'
  | 'COUPON_INVALID'
  | 'ORDER_NOT_FOUND'
  | 'GATEWAY_ERROR'
  | 'GATEWAY_NOT_CONFIGURED'
  | 'WEBHOOK_SIGNATURE_INVALID'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    statusCode: number,
    details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.statusCode = statusCode;
    if (details !== undefined) this.details = details;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Dados inválidos.', details?: unknown) {
    super('VALIDATION_ERROR', message, 422, details);
  }
}

export class PackNotFoundError extends AppError {
  constructor(packId: string) {
    super('PACK_NOT_FOUND', `Pack "${packId}" não existe.`, 404);
  }
}

export class PackNotPurchasableError extends AppError {
  constructor(packId: string) {
    super('PACK_NOT_PURCHASABLE', `O pack "${packId}" é gratuito e não vai pro checkout.`, 400);
  }
}

export class CouponInvalidError extends AppError {
  constructor(message = 'Cupom inválido ou expirado.') {
    super('COUPON_INVALID', message, 422);
  }
}

export class OrderNotFoundError extends AppError {
  constructor(orderId: string) {
    super('ORDER_NOT_FOUND', `Pedido "${orderId}" não encontrado.`, 404);
  }
}

export class GatewayError extends AppError {
  constructor(message = 'Falha ao falar com o provedor de pagamento.', details?: unknown) {
    super('GATEWAY_ERROR', message, 502, details);
  }
}

export class GatewayNotConfiguredError extends AppError {
  constructor(message = 'Provedor de pagamento não configurado.') {
    super('GATEWAY_NOT_CONFIGURED', message, 500);
  }
}

export class WebhookSignatureError extends AppError {
  constructor(message = 'Assinatura do webhook inválida.') {
    super('WEBHOOK_SIGNATURE_INVALID', message, 401);
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
