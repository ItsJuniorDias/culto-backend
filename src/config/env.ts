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
    CORS_ORIGIN: z.string().default('http://localhost:5173'),

    PAYMENT_PROVIDER: z.enum(['mock', 'pradapay']).default('mock'),

    MOCK_AUTO_APPROVE_CARD: booleanish.default(true),
    MOCK_AUTO_APPROVE_PIX: booleanish.default(true),
    MOCK_AUTO_APPROVE_BOLETO: booleanish.default(false),

    PRADAPAY_API_KEY: z.string().optional(),
    PRADAPAY_BASE_URL: z.string().url().default('https://api.pradapay.com'),
    /**
     * Cartão na PradaPay trafega PAN cru (sem tokenização). Mantenha DESLIGADO
     * a menos que você assuma o escopo PCI-DSS. O fluxo recomendado é Pix.
     */
    PRADAPAY_ENABLE_CARD: booleanish.default(false),

    ENABLE_DEV_ROUTES: booleanish.default(true),
  })
  // Se for usar PradaPay de verdade, exige a credencial da API.
  .superRefine((env, ctx) => {
    if (env.PAYMENT_PROVIDER === 'pradapay') {
      if (!env.PRADAPAY_API_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['PRADAPAY_API_KEY'],
          message: 'Obrigatório quando PAYMENT_PROVIDER=pradapay.',
        });
      }
      // Obs.: a PradaPay NÃO assina o webhook (não há segredo de webhook). A
      // autenticidade do callback é garantida re-consultando o status na API.
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

/** Lista de origens do CORS já normalizada. */
export function corsOrigins(env: Env): string[] {
  return env.CORS_ORIGIN.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
