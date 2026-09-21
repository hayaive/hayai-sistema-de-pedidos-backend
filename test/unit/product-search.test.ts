/**
 * Unitarios de `searchProducts` (src/catalog/product-search.ts): el buscador por
 * nombre o código de `GET /products?search=`, el mismo que usa el mostrador.
 *
 *   node --test test/unit/*.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchProducts } from '../../src/catalog/product-search.ts';

const CATALOG = [
  { code: '3L', name: 'tres-leches' },
  { code: 'cho le', name: 'choco-leche' },
  { code: 't.S', name: 'torta suiza' },
  { code: 'TQ', name: 'torta-quesillo' },
  { code: 'QP', name: 'Quesillo pote' },
  { code: 'Piña', name: 'Biscocho piña' },
  { code: 'p niña', name: 'pecho de niña' },
  { code: '1,5 kg', name: 'kilo y medio' },
  { code: 'pan gyab', name: 'pan de guayaba grade' },
  { code: 'globo fc', name: 'globo feliz cumpleaños' },
];
const codes = (q: string) => searchProducts(CATALOG, q).map((p) => p.code);

test('mayúsculas y minúsculas dan lo mismo', () => {
  assert.deepEqual(codes('tq'), ['TQ']);
  assert.deepEqual(codes('TQ'), ['TQ']);
  assert.deepEqual(codes('3l'), ['3L']);
});

test('acentos y eñes dan lo mismo', () => {
  assert.deepEqual(codes('pina'), ['Piña']);
  assert.deepEqual(codes('PIÑA'), ['Piña']);
  assert.deepEqual(codes('cumpleanos'), ['globo fc']);
});

test('espacios, puntos y comas del código no estorban', () => {
  assert.deepEqual(codes('chole'), ['cho le']);
  assert.deepEqual(codes('ts'), ['t.S']);
  assert.deepEqual(codes('15kg'), ['1,5 kg']);
  assert.deepEqual(codes('p nina'), ['p niña']);
});

test('palabras del nombre en cualquier orden', () => {
  assert.deepEqual(codes('guayaba pan'), ['pan gyab']);
});

test('el código exacto va primero que los que sólo contienen el texto', () => {
  assert.deepEqual(codes('quesillo'), ['QP', 'TQ']);
  assert.equal(codes('leche')[0], '3L');
});

test('búsqueda vacía devuelve todo; sin coincidencias, nada', () => {
  assert.equal(codes('   ').length, CATALOG.length);
  assert.deepEqual(codes('xyz'), []);
});
