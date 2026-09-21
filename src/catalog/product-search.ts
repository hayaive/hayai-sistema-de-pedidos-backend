/**
 * Buscador de productos por **nombre o código**, tolerante a como se escriba:
 * sin distinguir mayúsculas, acentos (`piña` = `pina`), guiones, puntos ni
 * espacios (`chole` encuentra el código `cho le`), y con las palabras en
 * cualquier orden. Los resultados salen ordenados por cercanía, con el código
 * exacto primero.
 *
 * Es la **misma regla** que aplica el frontend sobre su caché
 * (`karelys-pedidos/src/lib/search.ts`): si cambias una, cambia la otra.
 *
 * Se resuelve en memoria y no en SQL a propósito: `contains` + `insensitive` de
 * Prisma (ILIKE) distingue acentos, y quitarlos en Postgres pide la extensión
 * `unaccent` y un índice de expresión — un cambio de esquema que un catálogo de
 * decenas de productos no justifica.
 */

/** Marcas diacríticas que aparecen al normalizar en NFD ("í" → "i" + tilde). */
const MARKS = /\p{Diacritic}/gu;

function fold(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(MARKS, '');
}

function wordsOf(folded: string): string[] {
  return folded.split(/[^a-z0-9]+/).filter(Boolean);
}

/** Un token corto (1–2 letras) sólo cuenta al inicio de palabra: si no, "t s"
 *  encontraría medio catálogo. Uno largo vale en cualquier parte. */
const SHORT_TOKEN = 2;

export interface SearchableProduct {
  name: string;
  code: string;
}

/** Cercanía a lo buscado: menor es mejor, `null` si no coincide. */
export function productSearchScore(p: SearchableProduct, query: string): number | null {
  const tokens = wordsOf(fold(query));
  if (!tokens.length) return 0;
  const compactQuery = tokens.join('');

  const codeWords = wordsOf(fold(p.code));
  const nameWords = wordsOf(fold(p.name));
  const code = codeWords.join('');
  const name = nameWords.join('');

  if (code === compactQuery) return 0;
  if (code.startsWith(compactQuery)) return 1;
  if (name.startsWith(compactQuery)) return 2;
  if (code.includes(compactQuery)) return 3;
  if (name.includes(compactQuery)) return 4;

  const words = [...nameWords, ...codeWords];
  const every = tokens.every((t) =>
    t.length <= SHORT_TOKEN
      ? words.some((w) => w.startsWith(t))
      : words.some((w) => w.includes(t)) || name.includes(t) || code.includes(t),
  );
  return every ? 5 : null;
}

/** Filtra y ordena por cercanía (orden estable). Búsqueda vacía = lista tal cual. */
export function searchProducts<T extends SearchableProduct>(products: T[], query: string): T[] {
  if (!wordsOf(fold(query)).length) return products;
  const scored: { p: T; score: number; i: number }[] = [];
  products.forEach((p, i) => {
    const score = productSearchScore(p, query);
    if (score !== null) scored.push({ p, score, i });
  });
  scored.sort((a, b) => a.score - b.score || a.i - b.i);
  return scored.map((x) => x.p);
}
