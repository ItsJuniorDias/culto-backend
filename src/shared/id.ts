import { randomUUID } from 'node:crypto';

/**
 * IDs com prefixo legível (estilo Stripe): `ord_3f2a...`, `mock_9b1c...`.
 * O prefixo facilita identificar o tipo do recurso em logs e no banco.
 */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}
