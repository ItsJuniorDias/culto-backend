import type { FastifyInstance } from 'fastify';

/**
 * Mantém o CORPO CRU da requisição em `request.rawBody`.
 *
 * O webhook precisa do byte-a-byte original pra conferir a assinatura HMAC —
 * se a gente deixar o Fastify parsear e jogar o cru fora, não dá pra validar.
 * Aqui trocamos o parser de JSON: ele guarda o Buffer e, em paralelo, entrega
 * o objeto parseado em `request.body` (como de costume nas outras rotas).
 */

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export function registerRawBody(app: FastifyInstance): void {
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      const buf = body as Buffer;
      req.rawBody = buf;
      if (buf.length === 0) {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(buf.toString('utf8')));
      } catch (err) {
        const e = err as Error & { statusCode?: number };
        e.statusCode = 400;
        done(e, undefined);
      }
    },
  );
}
