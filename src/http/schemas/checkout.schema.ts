import { z } from 'zod';
import { PAYMENT_METHODS } from '../../domain/payments/payment.types.js';

/**
 * Validação de entrada com zod. As regras de CPF/e-mail espelham as do front
 * (src/lib/forms.js) — mas aqui valem de verdade: o servidor não confia no
 * cliente. Tudo que passa por aqui sai tipado.
 */

const onlyDigits = (s: string): string => (s || '').replace(/\D/g, '');

/** Dígitos verificadores do CPF (mesmo algoritmo do front). */
export function isValidCPF(value: string): boolean {
  const n = onlyDigits(value);
  if (n.length !== 11 || /^(\d)\1{10}$/.test(n)) return false;
  const digit = (len: number, factorStart: number): number => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(n[i]) * (factorStart - i);
    const d = 11 - (sum % 11);
    return d >= 10 ? 0 : d;
  };
  return digit(9, 10) === Number(n[9]) && digit(10, 11) === Number(n[10]);
}

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'E-mail inválido.');

const cpfSchema = z
  .string()
  .refine(isValidCPF, 'CPF inválido.')
  // Normaliza pra só dígitos — é o que o gateway espera.
  .transform(onlyDigits);

/**
 * Telefone BR. Opcional no schema (o mock/checkout simulado não exige), mas
 * OBRIGATÓRIO quando o provider é PradaPay — o adapter dela falha com mensagem
 * clara se vier vazio. Normaliza pra dígitos (DDD + número, com ou sem +55).
 */
const phoneSchema = z
  .string()
  .trim()
  .transform(onlyDigits)
  .refine((d) => d.length >= 10 && d.length <= 13, 'Telefone inválido (informe o DDD).');

/**
 * Cartão CRU — só faz sentido com PradaPay + PRADAPAY_ENABLE_CARD=true (a
 * PradaPay não tem tokenização). ATENÇÃO PCI-DSS: receber PAN aqui amplia seu
 * escopo. Opcional; o fluxo recomendado é Pix.
 */
const rawCardSchema = z.object({
  holder: z.string().trim().min(1, 'Nome no cartão é obrigatório.'),
  number: z
    .string()
    .trim()
    .transform(onlyDigits)
    .refine((d) => d.length >= 13 && d.length <= 19, 'Número de cartão inválido.'),
  expMonth: z.string().trim().regex(/^(0[1-9]|1[0-2])$/, 'Mês de validade inválido (MM).'),
  expYear: z.string().trim().regex(/^\d{2}$/, 'Ano de validade inválido (AA).'),
  cvv: z.string().trim().regex(/^\d{3,4}$/, 'CVV inválido.'),
});

export const createCheckoutSchema = z.object({
  packId: z.string().trim().min(1, 'packId é obrigatório.'),
  paymentMethod: z.enum(PAYMENT_METHODS),
  customer: z.object({
    email: emailSchema,
    cpf: cpfSchema,
    name: z.string().trim().min(1).optional(),
    phone: phoneSchema.optional(),
  }),
  couponCode: z.string().trim().min(1).optional(),
  // Só fazem sentido pra cartão; o service ignora nos outros métodos.
  installments: z.coerce.number().int().min(1).max(12).optional(),
  cardToken: z.string().trim().min(1).optional(),
  card: rawCardSchema.optional(),
});

export const validateCouponSchema = z.object({
  packId: z.string().trim().min(1, 'packId é obrigatório.'),
  code: z.string().trim().min(1, 'code é obrigatório.'),
});

export const orderIdParamSchema = z.object({
  id: z.string().trim().min(1),
});

export const providerParamSchema = z.object({
  provider: z.string().trim().min(1),
});

export type CreateCheckoutBody = z.infer<typeof createCheckoutSchema>;
export type ValidateCouponBody = z.infer<typeof validateCouponSchema>;
