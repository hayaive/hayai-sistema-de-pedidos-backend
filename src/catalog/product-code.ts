/**
 * Cálculo puro del código de producto sugerido (Ajustes → secuencia
 * automática). Separado de `ProductsService` para poder probarlo sin tocar
 * Prisma: no depende de nada más que de la lista de códigos ya usados.
 *
 * Decisión de J.O.R.B.I (ver `company_settings.product_code_start` en
 * `schema.prisma`): el piso es **configurable, no un contador**. El código
 * sugerido es el menor número libre ≥ piso en la serie `prefijo+dígitos`, y el
 * servidor nunca avanza el piso al crear un producto.
 */

export interface ProductCodeConfig {
  /** `company_settings.product_code_prefix`. */
  prefix: string;
  /** `company_settings.product_code_digits`: ancho de relleno con ceros. */
  digits: number;
  /** `company_settings.product_code_start`: piso, no contador. */
  start: number;
}

/**
 * Número de serie de `code` si pertenece a `prefix`, o `null` si no calza
 * (otro prefijo, o el resto no es todo dígitos). La comparación es numérica:
 * "P0061" ocupa el 61 aunque tenga más ceros que `digits` configurados.
 */
function seriesNumber(code: string, prefix: string): number | null {
  if (!code.startsWith(prefix)) return null;
  const rest = code.slice(prefix.length);
  if (rest.length === 0 || !/^[0-9]+$/.test(rest)) return null;
  return Number(rest);
}

/**
 * Menor número libre ≥ `config.start` en la serie `config.prefix`, formateado
 * con `config.digits` ceros a la izquierda. Si el número libre no cabe en
 * `digits` **no se trunca** (p.ej. "P1000" con `digits = 3`).
 */
export function nextProductCode(usedCodes: Iterable<string>, config: ProductCodeConfig): string {
  const occupied = new Set<number>();
  for (const code of usedCodes) {
    const n = seriesNumber(code, config.prefix);
    if (n !== null) occupied.add(n);
  }

  let n = config.start;
  while (occupied.has(n)) n++;
  return config.prefix + String(n).padStart(config.digits, '0');
}
