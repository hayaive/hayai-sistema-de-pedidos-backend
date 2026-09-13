/**
 * Relojes de los dispositivos (ARCHITECTURE.md §4.6).
 *
 * Un equipo con la fecha mal puesta envenena el día contable, y el día contable
 * es lo que cuadra la caja. Reglas:
 *  · el servidor **acota** todo timestamp de negocio que recibe al rango
 *    [ahora − CLOCK_PAST_DAYS, ahora + CLOCK_FUTURE_MINUTES];
 *  · guarda siempre además su propio `received_at`;
 *  · el día contable no se deriva del cliente: lo pone el trigger de la base.
 */

/** Días hacia atrás que se aceptan en un timestamp de cliente. */
export const CLOCK_PAST_DAYS = 30;
/** Minutos hacia adelante que se toleran (desfase normal de reloj). */
export const CLOCK_FUTURE_MINUTES = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ClampResult {
  at: Date;
  /** true si hubo que mover la fecha: el llamador lo audita. */
  clamped: boolean;
  /** Lo que mandó el cliente, si era una fecha válida. */
  original: Date | null;
}

/**
 * Acota un timestamp de cliente contra el reloj del servidor. Una fecha ausente
 * o ilegible se sustituye por `now` sin considerarse "clamped": no hay nada que
 * corregir, simplemente no vino.
 */
export function clampClientTime(raw: unknown, now: Date = new Date()): ClampResult {
  const parsed = parseDate(raw);
  if (!parsed) return { at: now, clamped: false, original: null };

  const min = new Date(now.getTime() - CLOCK_PAST_DAYS * DAY_MS);
  const max = new Date(now.getTime() + CLOCK_FUTURE_MINUTES * 60 * 1000);

  if (parsed < min) return { at: min, clamped: true, original: parsed };
  if (parsed > max) return { at: max, clamped: true, original: parsed };
  return { at: parsed, clamped: false, original: parsed };
}

export function parseDate(raw: unknown): Date | null {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** ISO del reloj del servidor. Va en toda respuesta (`serverTime`). */
export const serverTime = () => new Date().toISOString();

/**
 * `YYYY-MM-DD` de una fecha en una zona dada. Se usa para el **borrador** del
 * cierre y para validar el parámetro `date`; la columna `business_date` de las
 * filas la pone siempre el trigger, nunca esto.
 */
export function businessDateOf(at: Date, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(at); // en-CA da YYYY-MM-DD
}

/** true si la cadena es un día contable válido (`YYYY-MM-DD`). */
export function isBusinessDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Un día contable (`YYYY-MM-DD`) como el `Date` que espera una columna `@db.Date`.
 * Prisma manda `@db.Date` en UTC, así que el día se fija a medianoche UTC para
 * que no se desplace.
 */
export function businessDateToUtc(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** Columna `@db.Date` → `YYYY-MM-DD`. */
export function utcToBusinessDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}
