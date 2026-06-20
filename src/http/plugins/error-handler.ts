import type { FastifyInstance } from 'fastify';
import { isAppError } from '../../shared/errors.js';

/**
 * Tradutor central de erros -> JSON. Formato de resposta padronizado:
 *   { error: { code, message, details? } }
 *
 * - AppError: usa code/statusCode/details definidos no domínio.
 * - Erro de parse do body (400 do Fastify): vira VALIDATION_ERROR.
 * - Qualquer outra coisa: 500 genérico, SEM vazar stack/detalhe interno.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (isAppError(error)) {
      if (error.statusCode >= 500) {
        request.log.error({ err: error }, error.message);
      }
      reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
      });
      return;
    }

    // Erros de validação de schema/parse do próprio Fastify.
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    if (statusCode === 400) {
      reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Requisição malformada.' },
      });
      return;
    }

    request.log.error({ err: error }, 'erro não tratado');
    reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Erro interno. Tente novamente.' },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: { code: 'NOT_FOUND', message: `Rota não encontrada: ${request.method} ${request.url}` },
    });
  });
}
