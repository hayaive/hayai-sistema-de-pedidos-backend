/**
 * Unitarios de `nextProductCode` (src/catalog/product-code.ts): el cálculo
 * puro detrás de `ProductsService.nextFreeCode` y de la secuencia automática
 * de códigos de producto de Ajustes.
 *
 * Corre con el runner nativo de Node (`node --test`, sin dependencias nuevas):
 *
 *   node --test test/unit/*.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextProductCode } from '../../src/catalog/product-code.ts';

test('piso: sin códigos usados, sugiere exactamente el piso configurado', () => {
  const code = nextProductCode([], { prefix: 'P', digits: 3, start: 5 });
  assert.equal(code, 'P005');
});

test('huecos: rellena el primer número libre por debajo de uno ya usado', () => {
  const code = nextProductCode(['P001', 'P003'], { prefix: 'P', digits: 3, start: 1 });
  assert.equal(code, 'P002');
});

test('retirados: un código retirado ocupa su número igual que uno vivo', () => {
  // `usedCodes` ya llega fusionado (productos vivos ∪ retired_product_codes);
  // la función no distingue el origen, así que un código retirado bloquea el
  // hueco exactamente igual.
  const code = nextProductCode(['P001'], { prefix: 'P', digits: 3, start: 1 });
  assert.equal(code, 'P002');
});

test('comparación numérica: P0061 ocupa el 61 aunque tenga más ceros que "digits"', () => {
  const code = nextProductCode(['P0061'], { prefix: 'P', digits: 3, start: 61 });
  assert.equal(code, 'P062');
});

test('un código con otro prefijo no ocupa nada de la serie', () => {
  const code = nextProductCode(['Q005'], { prefix: 'P', digits: 3, start: 1 });
  assert.equal(code, 'P001');
});

test('overflow de dígitos: el número libre no se trunca al ancho configurado', () => {
  const code = nextProductCode([], { prefix: 'P', digits: 3, start: 1000 });
  assert.equal(code, 'P1000');
});

test('overflow de dígitos combinado con huecos por encima del ancho', () => {
  const code = nextProductCode(['P1000', 'P1001'], { prefix: 'P', digits: 3, start: 1000 });
  assert.equal(code, 'P1002');
});

test('prefijo con caracteres especiales (guion) se compara literal, sin regex', () => {
  const code = nextProductCode(['X-007'], { prefix: 'X-', digits: 3, start: 7 });
  assert.equal(code, 'X-008');
});

test('prefijo con guion no choca con una serie de prefijo distinto que también usa guion', () => {
  const code = nextProductCode(['P-007'], { prefix: 'X-', digits: 3, start: 1 });
  assert.equal(code, 'X-001');
});

test('el piso configurado nunca baja: un hueco libre por debajo del piso se ignora', () => {
  const code = nextProductCode(['P001', 'P002'], { prefix: 'P', digits: 3, start: 10 });
  assert.equal(code, 'P010');
});
