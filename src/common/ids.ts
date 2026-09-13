/**
 * Identidad de los registros (ARCHITECTURE.md §3.1).
 *
 * Conviven ids semánticos heredados del frontend (`pt-mayor`, `cat-tortas-frias`,
 * `prod-P060`) con UUID nuevos: el backend **no impone formato**, sólo unicidad.
 * Los semánticos son constantes en el código del frontend y convertirlos a uuid
 * obligaría a reescribir `pricing-rules.ts`, que está fuera de alcance.
 */

/** Réplica de `lib/ids.slug`: "Tortas Frías" → "tortas-frias". */
export function slug(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

/** Réplica de `lib/ids.normalizeName`: comparación de nombres sin tildes ni caja. */
export function normalizeName(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Cédula normalizada: mayúsculas y sin espacios. La unicidad no sirve de nada si
 * la misma persona entra como "v-123" y "V-123" — y hay un CHECK
 * (`customers_cedula_upper_ck`) que lo exige.
 */
export function normalizeCedula(cedula: string): string {
  return cedula.trim().toUpperCase().replace(/\s+/g, '');
}
