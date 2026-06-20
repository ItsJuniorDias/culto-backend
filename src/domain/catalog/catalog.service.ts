import { catalog, findPack, type Pack } from './catalog.js';
import { PackNotFoundError, PackNotPurchasableError } from '../../shared/errors.js';
import { formatBRL } from '../../shared/money.js';

export interface PackDTO {
  id: string;
  title: string;
  priceCents: number;
  priceFormatted: string;
  free: boolean;
}

function toDTO(pack: Pack): PackDTO {
  return {
    id: pack.id,
    title: pack.title,
    priceCents: pack.priceCents,
    priceFormatted: pack.free ? 'Grátis' : formatBRL(pack.priceCents),
    free: pack.free,
  };
}

export class CatalogService {
  list(): PackDTO[] {
    return catalog.map(toDTO);
  }

  get(id: string): PackDTO {
    const pack = findPack(id);
    if (!pack) throw new PackNotFoundError(id);
    return toDTO(pack);
  }

  /** Retorna o pack garantindo que ele é comprável (existe e não é grátis). */
  requirePurchasable(id: string): Pack {
    const pack = findPack(id);
    if (!pack) throw new PackNotFoundError(id);
    if (pack.free) throw new PackNotPurchasableError(id);
    return pack;
  }
}
