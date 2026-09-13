/**
 * Formas de consulta de los agregados. El delta viaja por **raíces de agregado**
 * con sus hijas dentro (ARCHITECTURE.md §4.3), así que `/bootstrap`, `GET /sync`
 * y los endpoints de dominio tienen que leer exactamente lo mismo: si cada uno
 * declarara su propio `include`, un campo nuevo aparecería en una ruta y no en
 * la otra, y el cliente vería agregados incompletos según de dónde vinieran.
 */

export const ROLE_INCLUDE = { permissions: true } as const;

export const PRODUCT_INCLUDE = {
  prices: true,
  comboItems: { orderBy: { position: 'asc' } },
} as const;

export const PRICE_GROUP_INCLUDE = { prices: true } as const;

export const ORDER_INCLUDE = {
  items: { orderBy: { position: 'asc' } },
  deposits: { orderBy: { at: 'asc' } },
} as const;

export const SALE_INCLUDE = {
  items: { orderBy: { position: 'asc' } },
  payments: { orderBy: { position: 'asc' } },
} as const;

export const CLOSURE_INCLUDE = { methods: true } as const;
