import { randomUUID } from 'node:crypto';
import { Product } from '../generated/prisma/client';
import { LineItemDto } from './dto/line-item.dto';
import { invalid } from './errors';
import { Dec, qty as qtyScale, bs as bsScale, usd as usdScale, zero } from './money';
import { Tx } from './tx';

export interface BuiltLine {
  position: number;
  productId: string;
  code: string;
  name: string;
  qty: Dec;
  priceTypeId: string;
  unitPriceUsd: Dec;
  unitPriceBs: Dec | null;
  bsOnly: boolean;
  customization: string | null;
  customizationPrice: Dec | null;
  subtotalUsd: Dec;
}

export interface BuiltLines {
  lines: BuiltLine[];
  /** Los productos de las líneas, para no volver a consultarlos al mover stock. */
  products: Map<string, Product>;
}

/**
 * Construye las líneas de una venta o un pedido.
 *
 * Lo que se acepta del cliente y lo que no:
 *  · `code`/`name` se aceptan (foto histórica, §3.3); si no vienen, del catálogo.
 *  · `subtotalUsd` se **calcula aquí**: `qty × (unitPriceUsd + customizationPrice)`.
 *    Es dinero derivado, y aceptarlo permitiría un documento cuyo total no cuadra
 *    con sus propias líneas.
 *  · una línea `bsOnly` aporta 0 al total en USD (igual que `itemsTotals` del
 *    frontend) y necesita `unitPriceBs`, que exige el CHECK
 *    `*_items_bs_only_needs_price_ck`.
 */
export async function buildLines(tx: Tx, items: LineItemDto[]): Promise<BuiltLines> {
  if (!items.length) throw invalid('El documento no tiene líneas');

  const ids = [...new Set(items.map((i) => i.productId))];
  const found = await tx.product.findMany({ where: { id: { in: ids } } });
  const products = new Map(found.map((p) => [p.id, p]));

  const missing = ids.filter((id) => !products.has(id));
  if (missing.length) {
    // Una referencia a un producto inexistente NO se ignora en silencio: en el
    // frontend `applyMovement` hace `if (!p) return`, y ahí una línea huérfana no
    // da error, da pérdida silenciosa de stock (§3.3).
    throw invalid(`Hay líneas con productos que no existen: ${missing.join(', ')}`);
  }

  const priceTypeIds = [...new Set(items.map((i) => i.priceTypeId))];
  const priceTypes = await tx.priceType.findMany({
    where: { id: { in: priceTypeIds } },
    select: { id: true },
  });
  const knownTypes = new Set(priceTypes.map((p) => p.id));
  const unknownTypes = priceTypeIds.filter((id) => !knownTypes.has(id));
  if (unknownTypes.length) {
    throw invalid(`Hay líneas con tipos de precio que no existen: ${unknownTypes.join(', ')}`);
  }

  const lines: BuiltLine[] = items.map((item, position) => {
    const product = products.get(item.productId)!;
    const bsOnly = item.bsOnly ?? product.bsOnly;

    const quantity = qtyScale(item.qty, 'qty');
    if (quantity.lte(0)) throw invalid('La cantidad de una línea tiene que ser mayor que cero');

    const unitPriceUsd = usdScale(item.unitPriceUsd, 'unitPriceUsd');
    const customizationPrice =
      item.customizationPrice === undefined || item.customizationPrice === null
        ? null
        : usdScale(item.customizationPrice, 'customizationPrice');

    const unitPriceBs =
      item.unitPriceBs !== undefined && item.unitPriceBs !== null
        ? bsScale(item.unitPriceBs, 'unitPriceBs')
        : bsOnly && product.bsPrice !== null
          ? bsScale(product.bsPrice, 'bsPrice')
          : null;

    if (bsOnly && unitPriceBs === null) {
      throw invalid(`La línea de "${product.name}" es bsOnly y necesita unitPriceBs`);
    }

    // Una línea bsOnly no aporta al total en USD: su precio está fijado en Bs y
    // no se convierte (`itemsTotals` del frontend la suma como 0).
    const subtotalUsd = bsOnly
      ? zero()
      : usdScale(quantity.times(unitPriceUsd.plus(customizationPrice ?? zero())), 'subtotalUsd');

    return {
      position,
      productId: product.id,
      code: item.code ?? product.code,
      name: item.name ?? product.name,
      qty: quantity,
      priceTypeId: item.priceTypeId,
      unitPriceUsd,
      unitPriceBs,
      bsOnly,
      customization: item.customization ?? null,
      customizationPrice,
      subtotalUsd,
    };
  });

  return { lines, products };
}

/**
 * Totales de un documento. Réplica de `lib/pricing.itemsTotals`:
 *  · `totalUsd` = suma de subtotales, excluyendo las líneas `bsOnly`;
 *  · `totalBs`  = suma de cada línea convertida con la tasa recibida, **sin
 *    redondeo intermedio** (las líneas `bsOnly` entran con su precio en Bs).
 *
 * El total en Bs se calcula al vuelo con la tasa del momento: nunca se persiste
 * un monto en Bs derivado de un precio en USD salvo este total de venta, que se
 * guarda junto con la tasa congelada con la que se calculó.
 */
export function totalsOf(lines: BuiltLine[], rate: Dec): { totalUsd: Dec; totalBs: Dec } {
  let totalUsd = zero();
  let totalBs = zero();

  for (const line of lines) {
    totalUsd = totalUsd.plus(line.subtotalUsd);
    totalBs = totalBs.plus(
      line.bsOnly ? (line.unitPriceBs ?? zero()).times(line.qty) : line.subtotalUsd.times(rate),
    );
  }

  return { totalUsd: usdScale(totalUsd, 'totalUsd'), totalBs: bsScale(totalBs, 'totalBs') };
}

/** Suma de subtotales en USD. Es el `totalUsd` de un pedido (sin tasa de por medio). */
export function orderTotalOf(lines: BuiltLine[]): Dec {
  return usdScale(
    lines.reduce((acc, l) => acc.plus(l.subtotalUsd), zero()),
    'totalUsd',
  );
}

/** Columnas comunes de una línea, sin la FK al padre. */
function lineColumns(line: BuiltLine) {
  return {
    id: randomUUID(),
    position: line.position,
    productId: line.productId,
    code: line.code,
    name: line.name,
    qty: line.qty,
    priceTypeId: line.priceTypeId,
    unitPriceUsd: line.unitPriceUsd,
    unitPriceBs: line.unitPriceBs,
    bsOnly: line.bsOnly,
    customization: line.customization,
    customizationPrice: line.customizationPrice,
    subtotalUsd: line.subtotalUsd,
  };
}

export const saleItemRows = (lines: BuiltLine[], saleId: string) =>
  lines.map((l) => ({ ...lineColumns(l), saleId }));

export const orderItemRows = (lines: BuiltLine[], orderId: string) =>
  lines.map((l) => ({ ...lineColumns(l), orderId }));
