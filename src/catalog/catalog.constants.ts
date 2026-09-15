/**
 * Identidad de la familia de tortas frías. Réplica de
 * `C:\dev\karelys-pedidos\src\lib\pricing-rules.ts`: son **constantes en el
 * código del frontend**, así que los ids no se pueden regenerar (es la razón por
 * la que las PK son TEXT y no uuid, ARCHITECTURE.md §1).
 */

export const COLD_CAKE_CATEGORY_ID = 'cat-tortas-frias';
export const COLD_CAKE_CATEGORY_NAME = 'Tortas Frías';

/**
 * Umbral de alerta de precio bajo y precio objetivo sugerido. Son los valores
 * por defecto de `company_settings.cold_cake_min` / `cold_cake_max` (los pone la
 * migración inicial); el negocio puede cambiarlos desde Ajustes.
 */
export const COLD_CAKE_ALERT_USD = 1.1;
export const COLD_CAKE_TARGET_USD = 1.3;

/**
 * Ids de los tres grupos de precio de la familia.
 *
 * @deprecated 2026-09 · El mecanismo de grupos de precio se retiró: cada producto
 * vuelve a tener precio propio en `product_prices`. Estos ids se conservan como
 * **identidad de las filas a limpiar** por la migración de datos y para que las
 * rutas de compatibilidad (`/price-groups`, `priceGroup.*` de sync) sigan
 * hablando de las mismas filas mientras queden clientes v5 en circulación.
 */
export const COLD_CAKE_GENERIC_GROUP_ID = 'pg-tortas-frias';
export const COLD_CAKE_OREO_BROWNIE_GROUP_ID = 'pg-oreo-brownie';
export const COLD_CAKE_QUESILLO_GROUP_ID = 'pg-torta-quesillo';

export const COLD_CAKE_GENERIC_CODE = 'P060';
export const OREO_BROWNIE_CODE = 'P059';
export const TORTA_QUESILLO_CODE = 'P015';

/**
 * Id del producto genérico "Tortas Frías". Los ids de producto del catálogo son
 * **semánticos y constantes** (`prod-<código>`, ver el encabezado de `seed.ts`),
 * así que el genérico se puede identificar sin depender de su categoría.
 *
 * Es la clave del nuevo modelo de banda: la banda mínimo/máximo de
 * `company_settings` aplica **sólo a este producto**, no a la categoría entera.
 * "Brownie" (P059) y "Torta Quesillo" (P015) quedan libres, como ya lo estaban.
 */
export const COLD_CAKE_GENERIC_PRODUCT_ID = 'prod-' + COLD_CAKE_GENERIC_CODE;

/** Renombrado de "Oreo y Brownie" a "Brownie" (alineado con el frontend). */
export const OREO_BROWNIE_NAME = 'Brownie';
export const TORTA_QUESILLO_NAME = 'Torta Quesillo';

export const PRICE_TYPE_MAYOR_ID = 'pt-mayor';
export const PRICE_TYPE_DETAL_ID = 'pt-detal';
