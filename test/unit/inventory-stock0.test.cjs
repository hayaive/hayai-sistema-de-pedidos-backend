/**
 * Unitarios de la regla "el stock nunca queda negativo" (2026-09-18):
 *  · `InventoryService.apply` recorta una `salida` al stock disponible en vez
 *    de rechazarla o dejar el stock en negativo.
 *  · `SalesService.void` devuelve lo que de verdad se descontó del ledger
 *    (`-SUM(delta)`), no `sale_items.qty`.
 *
 * No usa Prisma real: se ejercita la lógica de negocio con una transacción
 * falsa en memoria, siguiendo el mismo patrón que
 * `products-service-recode.test.cjs` (Postgres real ya lo cubre
 * `prisma/verify-ddl.js`, incluido el CHECK que respalda este recorte).
 *
 *   npm run build
 *   node --test test/unit/inventory-stock0.test.cjs
 */
require('reflect-metadata'); // los decoradores de Nest lo necesitan al cargar la clase
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');

const DIST = path.join(__dirname, '..', '..', 'dist');
let InventoryService, SalesService;
try {
  ({ InventoryService } = require(path.join(DIST, 'inventory', 'inventory.service.js')));
  ({ SalesService } = require(path.join(DIST, 'sales', 'sales.service.js')));
} catch (err) {
  throw new Error(
    `No se encontró dist/ compilado (${err.message}). Corre "npm run build" antes de este test.`,
  );
}

const AUDIT_NOOP = { log: async () => {} };
const USER = { id: 'user-1', fullName: 'Administradora' };

/** Número JS, venga de un `Decimal` de Prisma o de un valor plano de fixture. */
const toNum = (v) => (v && typeof v.toNumber === 'function' ? v.toNumber() : Number(v));

/**
 * Tx en memoria para `InventoryService.apply`: sólo un producto, sin ventas de
 * por medio. `$queryRaw` simula el `SELECT ... FOR NO KEY UPDATE` que hace
 * `apply` para bloquear la fila y leer el stock actual.
 */
function fakeInventoryTx(initialStock) {
  const product = { stock: initialStock };
  const movements = new Map();
  const tx = {
    $queryRaw: async (_strings, ..._values) => [{ stock: String(product.stock) }],
    inventoryMovement: {
      findUnique: async ({ where }) => movements.get(where.id) ?? null,
      create: async ({ data }) => {
        movements.set(data.id, data);
        return data;
      },
    },
    product: {
      update: async ({ data }) => {
        product.stock = data.stock;
        return { ...product };
      },
    },
  };
  return { tx, product };
}

function makeInventoryService() {
  return new InventoryService({}, AUDIT_NOOP);
}

test('salida que alcanza: descuenta qty completo', async () => {
  const service = makeInventoryService();
  const { tx, product } = fakeInventoryTx(10);

  const movement = await service.apply(tx, {
    productId: 'p1',
    type: 'salida',
    qty: 3,
    reason: 'Salida por venta',
    userId: 'user-1',
  });

  assert.equal(movement.delta.toNumber(), -3);
  assert.equal(movement.stockAfter.toNumber(), 7);
  assert.equal(product.stock.toNumber(), 7);
});

test('salida recortada: stock 2, qty 5 -> delta -2, stockAfter 0 (no se rechaza, no queda negativo)', async () => {
  const service = makeInventoryService();
  const { tx, product } = fakeInventoryTx(2);

  const movement = await service.apply(tx, {
    productId: 'p1',
    type: 'salida',
    qty: 5,
    reason: 'Salida por venta',
    userId: 'user-1',
  });

  assert.equal(movement.qty.toNumber(), 5); // qty guarda lo PEDIDO
  assert.equal(movement.delta.toNumber(), -2); // delta guarda lo REALMENTE descontado
  assert.equal(movement.stockAfter.toNumber(), 0);
  assert.equal(product.stock.toNumber(), 0);
});

test('salida sin existencia: stock 0 -> delta 0, stockAfter 0', async () => {
  const service = makeInventoryService();
  const { tx, product } = fakeInventoryTx(0);

  const movement = await service.apply(tx, {
    productId: 'p1',
    type: 'salida',
    qty: 4,
    reason: 'Salida por venta',
    userId: 'user-1',
  });

  assert.equal(movement.qty.toNumber(), 4);
  assert.ok(movement.delta.isZero(), `delta esperado 0, fue ${movement.delta}`); // -0 y 0 son el mismo Decimal
  assert.equal(movement.stockAfter.toNumber(), 0);
  assert.equal(product.stock.toNumber(), 0);
});

/**
 * Tx en memoria para `SalesService.void`: simula una venta con dos salidas
 * sobre el mismo producto (una completa y una recortada) y una salida sin
 * existencia sobre otro producto, para comprobar que la anulación devuelve
 * `-SUM(delta)` por producto y no repite el faltante ya perdido.
 */
function fakeSalesTx({ products, saleMovements, sale }) {
  const byId = new Map(products.map((p) => [p.id, { ...p }]));
  const movements = new Map(saleMovements.map((m) => [m.id, m]));
  const saleRow = { ...sale };

  const tx = {
    sale: {
      findUnique: async () => ({ ...saleRow }),
      update: async ({ data }) => {
        Object.assign(saleRow, data);
        return saleRow;
      },
    },
    inventoryMovement: {
      count: async ({ where }) =>
        [...movements.values()].filter(
          (m) => m.saleId === where.saleId && m.type === where.type && m.reason === where.reason,
        ).length,
      findUnique: async ({ where }) => movements.get(where.id) ?? null,
      create: async ({ data }) => {
        movements.set(data.id, data);
        return data;
      },
    },
    product: {
      update: async ({ where, data }) => {
        const p = byId.get(where.id);
        Object.assign(p, data);
        return { ...p };
      },
    },
    $queryRaw: async (strings, ...values) => {
      const sql = strings.join('');
      if (sql.includes('GROUP BY "product_id"')) {
        // Réplica en memoria de: SELECT product_id, -SUM(delta) ... GROUP BY
        // product_id HAVING SUM(delta) < 0
        const saleId = values[0];
        const sums = new Map();
        for (const m of movements.values()) {
          if (m.saleId !== saleId || m.type !== 'salida') continue;
          sums.set(m.productId, (sums.get(m.productId) ?? 0) + m.delta);
        }
        return [...sums.entries()]
          .filter(([, sum]) => sum < 0)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([productId, sum]) => ({ product_id: productId, qty: (-sum).toFixed(3) }));
      }
      if (Array.isArray(values[0])) {
        // Réplica del lock en bloque: no hace falta simular el lock en sí.
        return values[0].map((id) => ({ id }));
      }
      // Lock de una fila: lo que hace `InventoryService.apply` por dentro.
      const p = byId.get(values[0]);
      return p ? [{ stock: String(p.stock) }] : [];
    },
  };
  return { tx, byId, movements };
}

test('anulación: devuelve -SUM(delta) por producto (lo realmente descontado), no sale_items.qty', async () => {
  const inventory = makeInventoryService();
  const sales = new SalesService({}, {}, {}, inventory, {}, AUDIT_NOOP);

  // pA: sale_items.qty pedía 1 + 3 = 4, pero sólo había 1 de stock cuando se
  // vendió la segunda línea (recortada). Sólo se descontó 1 + 1 = 2 de verdad.
  // pB: se vendió 2 sin existencia (delta 0): no hay nada que devolver.
  const { tx, byId, movements } = fakeSalesTx({
    products: [
      { id: 'pA', stock: 0 },
      { id: 'pB', stock: 0 },
    ],
    saleMovements: [
      { id: 'm1', productId: 'pA', type: 'salida', qty: 1, delta: -1, saleId: 's1' },
      { id: 'm2', productId: 'pA', type: 'salida', qty: 3, delta: -1, saleId: 's1' },
      { id: 'm3', productId: 'pB', type: 'salida', qty: 2, delta: 0, saleId: 's1' },
    ],
    sale: { id: 's1', number: 'V-1', status: 'completada' },
  });

  const { sale, alreadyVoided } = await sales.void(USER, 's1', 'Cliente se arrepintió', { db: tx });

  assert.equal(alreadyVoided, false);
  assert.equal(sale.status, 'anulada');

  const returns = [...movements.values()].filter((m) => m.type === 'entrada' && m.saleId === 's1');
  assert.equal(returns.length, 1); // nada para pB: se vendió íntegramente sin existencia
  assert.equal(returns[0].productId, 'pA');
  assert.equal(toNum(returns[0].qty), 2); // -SUM(delta) = -(-1 + -1) = 2, no sale_items.qty (4)
  assert.equal(toNum(returns[0].delta), 2);

  assert.equal(toNum(byId.get('pA').stock), 2);
  assert.equal(toNum(byId.get('pB').stock), 0); // pB nunca se tocó: no había nada que devolver
});

test('anulación es idempotente: una segunda llamada no vuelve a devolver stock', async () => {
  const inventory = makeInventoryService();
  const sales = new SalesService({}, {}, {}, inventory, {}, AUDIT_NOOP);

  const { tx, byId, movements } = fakeSalesTx({
    products: [{ id: 'pA', stock: 0 }],
    saleMovements: [{ id: 'm1', productId: 'pA', type: 'salida', qty: 1, delta: -1, saleId: 's1' }],
    sale: { id: 's1', number: 'V-1', status: 'completada' },
  });

  await sales.void(USER, 's1', 'primera', { db: tx });
  const afterFirst = [...movements.values()].filter((m) => m.type === 'entrada').length;

  const { alreadyVoided } = await sales.void(USER, 's1', 'segunda', { db: tx });
  const afterSecond = [...movements.values()].filter((m) => m.type === 'entrada').length;

  assert.equal(alreadyVoided, true);
  assert.equal(afterSecond, afterFirst); // no se repite la devolución
  assert.equal(toNum(byId.get('pA').stock), 1);
});
