import { Prisma } from '../generated/prisma/client';

/**
 * Dinero: Decimal en la base, número JSON en el wire (ARCHITECTURE.md §6.1).
 *
 * Reglas que este módulo hace cumplir:
 *  · Nada de float en dinero: se opera con Decimal y se redondea a la escala de
 *    la columna al escribir.
 *  · El equivalente en Bs de un precio en USD **no se persiste** nunca: se
 *    calcula al mostrar o al cobrar. Sólo se congela la tasa cuando el dinero ya
 *    entró (`sales.rate_*`, `sale_payments.rate_used`, `order_deposits.rate_used`).
 *  · Las sumas de informes se hacen en SQL con `numeric`, nunca acumulando
 *    `number` en JS. Aquí sólo se convierte y se compara.
 */

export const Dec = Prisma.Decimal;
export type Dec = Prisma.Decimal;

/** Escalas de las columnas (deben coincidir con schema.prisma). */
export const SCALE = {
  /** USD `Decimal(14,4)` */
  usd: 4,
  /** Bs `Decimal(18,4)` */
  bs: 4,
  /** Tasa `Decimal(18,8)` */
  rate: 8,
  /** Cantidades `Decimal(14,3)` */
  qty: 3,
} as const;

/** Tolerancia en USD para comparaciones de dinero (centavos de redondeo). */
export const EPS = new Dec('0.02');

export type NumberLike = number | string | Dec | null | undefined;

/** A Decimal, sin redondear. Lanza si el valor no es un número finito. */
export function dec(value: NumberLike, field = 'monto'): Dec {
  if (value === null || value === undefined) throw new Error(`${field}: valor ausente`);
  const d = value instanceof Dec ? value : new Dec(value);
  if (!d.isFinite()) throw new Error(`${field}: valor no finito`);
  return d;
}

/** A Decimal redondeado a la escala de la columna (half-up, como el negocio). */
export function money(value: NumberLike, scale: number, field = 'monto'): Dec {
  return dec(value, field).toDecimalPlaces(scale, Dec.ROUND_HALF_UP);
}

export const usd = (v: NumberLike, field = 'monto USD') => money(v, SCALE.usd, field);
export const bs = (v: NumberLike, field = 'monto Bs') => money(v, SCALE.bs, field);
export const rateOf = (v: NumberLike, field = 'tasa') => money(v, SCALE.rate, field);
export const qty = (v: NumberLike, field = 'cantidad') => money(v, SCALE.qty, field);

/** Decimal → número JSON. `null`/`undefined` pasan tal cual. */
export function num(value: Dec | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' ? value : value.toNumber();
}

/** Decimal → número JSON, con 0 cuando falta. Para campos no anulables. */
export function num0(value: Dec | number | null | undefined): number {
  return num(value) ?? 0;
}

export const zero = () => new Dec(0);

/** Suma una lista de Decimal sin pasar por float. */
export function sum(values: Iterable<Dec>): Dec {
  let acc = new Dec(0);
  for (const v of values) acc = acc.plus(v);
  return acc;
}

/**
 * USD → Bs exacto (sin redondear). Es la conversión de `lib/money.usdToBs` del
 * frontend: el total en Bs de una venta se acumula sin redondeo intermedio.
 */
export function usdToBs(amountUsd: Dec, rate: Dec): Dec {
  return amountUsd.times(rate);
}

/** Bs → USD. 0 si no hay tasa (mismo comportamiento que `lib/money.bsToUsd`). */
export function bsToUsd(amountBs: Dec, rate: Dec): Dec {
  if (rate.lte(0)) return new Dec(0);
  return amountBs.div(rate);
}

/**
 * Redondeo al paso configurado en Bs (`company_settings.bs_rounding`,
 * 1 = bolívares enteros). Réplica de `lib/money.roundBs`.
 */
export function roundBs(amountBs: Dec, step: Dec): Dec {
  if (step.lte(0)) return amountBs;
  return amountBs.div(step).toDecimalPlaces(0, Dec.ROUND_HALF_UP).times(step);
}

/** |a − b| ≤ EPS */
export function closeEnough(a: Dec, b: Dec, eps: Dec = EPS): boolean {
  return a.minus(b).abs().lte(eps);
}
