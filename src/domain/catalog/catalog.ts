/**
 * Catálogo — a FONTE DA VERDADE dos preços fica no servidor.
 *
 * No front (src/data/catalog.js) o preço é só pra exibir. O backend NUNCA
 * confia em valor que vem do cliente: o total é sempre recalculado a partir
 * daqui. Isso fecha o buraco de alguém forjar `priceValue: 0` no checkout.
 *
 * Os `id`s batem com os do front. Preços em CENTAVOS.
 */

export interface Pack {
  id: string;
  title: string;
  /** Centavos. 0 = gratuito. */
  priceCents: number;
  free: boolean;
}

const PACKS: ReadonlyArray<Pack> = [
  { id: 'kids-space', title: "Kid's Learning — Space Pack", priceCents: 0, free: true },
  { id: 'design', title: 'Design Pack', priceCents: 19_700, free: false },
  { id: 'motion', title: 'Motion Pack', priceCents: 24_700, free: false },
  { id: 'bundle', title: 'Bundle Completo', priceCents: 39_700, free: false },
];

const BY_ID = new Map(PACKS.map((p) => [p.id, p]));

export const catalog: ReadonlyArray<Pack> = PACKS;

export function findPack(id: string): Pack | undefined {
  return BY_ID.get(id);
}
