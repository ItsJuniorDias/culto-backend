import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';

/**
 * Ponto de entrada. Valida a config, sobe o app e cuida do encerramento
 * gracioso (fecha conexões em vez de cair no meio de uma requisição).
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const app = await buildApp(env);

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(
      { provider: env.PAYMENT_PROVIDER, url: env.API_PUBLIC_URL },
      `CULTO checkout API no ar (provider: ${env.PAYMENT_PROVIDER})`,
    );
  } catch (err) {
    app.log.error(err, 'falha ao subir o servidor');
    process.exit(1);
  }

  // Encerramento gracioso: drena as requisições em andamento antes de sair.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      app.log.info(`${signal} recebido, encerrando...`);
      app
        .close()
        .then(() => process.exit(0))
        .catch((err) => {
          app.log.error(err, 'erro ao encerrar');
          process.exit(1);
        });
    });
  }
}

main().catch((err) => {
  // Erro antes do logger existir (ex.: config inválida) — vai pro stderr cru.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
