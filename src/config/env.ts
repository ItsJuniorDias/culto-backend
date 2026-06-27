import { z } from 'zod';

/**
 * Configuração validada no boot. Se algo obrigatório faltar ou vier torto,
 * o processo morre aqui com uma mensagem clara — melhor falhar no start do
 * que dar erro estranho lá na frente, em produção.
 */

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) => v === true || v === 'true' || v === '1');

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3333),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    APP_BASE_URL: z.string().url().default('http://localhost:5173'),
    API_PUBLIC_URL: z.string().url().default('http://localhost:3333'),
    CORS_ORIGIN: z
      .string()
      .default(
        'http://localhost:5173,https://cultododesigner.com.br,https://www.cultododesigner.com.br',
      ),

    PAYMENT_PROVIDER: z.enum(['mock', 'pradapay']).default('mock'),

    MOCK_AUTO_APPROVE_CARD: booleanish.default(true),
    MOCK_AUTO_APPROVE_PIX: booleanish.default(true),
    MOCK_AUTO_APPROVE_BOLETO: booleanish.default(false),

    PRADAPAY_API_KEY: z.string().optional(),
    PRADAPAY_BASE_URL: z.string().url().default('https://api.pradapay.com'),
    PRADAPAY_WEBHOOK_SECRET: z.string().optional(),

    ENABLE_DEV_ROUTES: booleanish.default(true),
  })
  // Se for usar PradaPay de verdade, exige as credenciais.
  .superRefine((env, ctx) => {
    if (env.PAYMENT_PROVIDER === 'pradapay') {
      if (!env.PRADAPAY_API_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['PRADAPAY_API_KEY'],
          message: 'Obrigatório quando PAYMENT_PROVIDER=pradapay.',
        });
      }
      // PRADAPAY_WEBHOOK_SECRET NÃO é exigido: a PradaPay não assina o webhook
      // (a doc não define assinatura). A confirmação é feita por polling do
      // endpoint de status. O campo continua aceito, mas é opcional.
    }
  });

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    // Aborta o boot com diagnóstico legível.
    throw new Error(`Configuração inválida (.env):\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Lista de origens do CORS já normalizada (sem barra no fim, sem espaços). */
export function corsOrigins(env: Env): string[] {
  return env.CORS_ORIGIN.split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}
