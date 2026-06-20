import type { ZodError, ZodTypeAny, z } from 'zod';
import { ValidationError } from '../shared/errors.js';

/** Formata os erros do zod num shape amigável pro front. */
function formatZodError(error: ZodError): Array<{ field: string; message: string }> {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}

/**
 * Faz parse com zod e devolve o valor TIPADO, ou lança ValidationError (422)
 * com a lista de campos. Centraliza pra todas as rotas validarem igual.
 */
export function parse<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ValidationError('Dados inválidos.', { issues: formatZodError(result.error) });
  }
  return result.data;
}
