/**
 * Identidad de la familia de tortas frías. Réplica de
 * `C:\dev\karelys-pedidos\src\lib\pricing-rules.ts`: son **constantes en el
 * código del frontend**, así que los ids no se pueden regenerar (es la razón por
 * la que las PK son TEXT y no uuid, ARCHITECTURE.md §1).
 */

export const COLD_CAKE_CATEGORY_ID = 'cat-tortas-frias';
export const COLD_CAKE_CATEGORY_NAME = 'Tortas Frías';

/** Umbral de alerta de precio bajo y precio objetivo sugerido. */
export const COLD_CAKE_ALERT_USD = 1.1;
export const COLD_CAKE_TARGET_USD = 1.3;

/** Las tres unidades de precio de la familia. */
export const COLD_CAKE_GENERIC_GROUP_ID = 'pg-tortas-frias';
export const COLD_CAKE_OREO_BROWNIE_GROUP_ID = 'pg-oreo-brownie';
export const COLD_CAKE_QUESILLO_GROUP_ID = 'pg-torta-quesillo';

export const COLD_CAKE_GENERIC_CODE = 'P060';
export const OREO_BROWNIE_CODE = 'P059';
export const TORTA_QUESILLO_CODE = 'P015';

export const OREO_BROWNIE_NAME = 'Oreo y Brownie';
export const TORTA_QUESILLO_NAME = 'Torta Quesillo';

export const COLD_CAKE_GENERIC_PRICES = { mayor: 1.1, detal: 1.11 };
export const COLD_CAKE_QUESILLO_PRICES = { mayor: 1.3, detal: 1.36 };
/**
 * "Oreo y Brownie" se alineó al escalón de "Torta Quesillo" por falta de dato del
 * negocio, no porque sea su precio real (ARCHITECTURE.md §11, pendiente 1).
 */
export const COLD_CAKE_OREO_BROWNIE_PRICES = { mayor: 1.3, detal: 1.36 };

export const PRICE_TYPE_MAYOR_ID = 'pt-mayor';
export const PRICE_TYPE_DETAL_ID = 'pt-detal';
