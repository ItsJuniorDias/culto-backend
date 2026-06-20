/**
 * Dinheiro em centavos (inteiros).
 *
 * Regra de ouro: nunca use `number` decimal (float) pra dinheiro. `0.1 + 0.2`
 * já erra. Aqui tudo trafega e é calculado em CENTAVOS inteiros; a conversão
 * pra reais/string só acontece na borda, pra exibir.
 *
 * Espelha as regras de parcelamento do front (src/lib/money.js), porém em
 * centavos, pra que back e front falem a mesma língua.
 */

const BRL = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

/** 19700 → "R$ 197,00" */
export function formatBRL(cents: number): string {
  return BRL.format(cents / 100);
}

/** 197 → 19700. Aceita number ou string ("197", "197.50"). */
export function reaisToCents(reais: number | string): number {
  const n = typeof reais === 'string' ? Number(reais.replace(',', '.')) : reais;
  return Math.round((Number.isFinite(n) ? n : 0) * 100);
}

/** Garante centavos inteiros e não-negativos. */
export function sanitizeCents(value: number): number {
  return Math.max(0, Math.round(Number(value) || 0));
}

export interface Installment {
  /** Número de parcelas (1..N). */
  number: number;
  /** Valor de cada parcela, em centavos. */
  amountCents: number;
  /** Rótulo pronto: "3x de R$ 65,67 sem juros". */
  label: string;
}

/**
 * Opções de parcelamento sem juros.
 * @param totalCents total em centavos
 * @param max número máximo de parcelas (padrão 12)
 * @param minInstallmentCents evita parcelas microscópicas (padrão R$ 10,00)
 */
export function installmentOptions(
  totalCents: number,
  { max = 12, minInstallmentCents = 1000 }: { max?: number; minInstallmentCents?: number } = {},
): Installment[] {
  const total = sanitizeCents(totalCents);
  const count = Math.max(1, Math.min(max, Math.floor(total / minInstallmentCents) || 1));

  return Array.from({ length: count }, (_, i) => {
    const number = i + 1;
    // Divisão inteira em centavos; a 1ª parcela absorve o resto pra fechar a conta.
    const base = Math.floor(total / number);
    const remainder = total - base * number;
    const amountCents = base + (number === 1 ? remainder : 0);
    const label =
      number === 1
        ? `1x de ${formatBRL(total)}`
        : `${number}x de ${formatBRL(base)} sem juros`;
    return { number, amountCents, label };
  });
}

/** Resolve a parcela escolhida, com clamp pro intervalo válido. */
export function resolveInstallment(totalCents: number, requested: number): Installment {
  const options = installmentOptions(totalCents);
  const index = Math.min(Math.max(1, requested), options.length) - 1;
  // options nunca é vazio (sempre tem ao menos 1x), mas o compilador não sabe.
  return options[index] ?? options[0]!;
}
