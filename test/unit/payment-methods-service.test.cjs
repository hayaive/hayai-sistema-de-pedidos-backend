/**
 * Unitarios de `PaymentMethodsService` con una transacción falsa en memoria: el
 * objetivo es cubrir las reglas de negocio puras (nombre duplicado, moneda con
 * historial, borrado con historial) sin depender de Postgres. Igual que
 * `products-service-recode.test.cjs`, corre contra el JS ya compilado por
 * `nest build` porque los decoradores de Nest no pasan por el type-stripping
 * nativo de `node --test`:
 *
 *   npm run build
 *   node --test test/unit/payment-methods-service.test.cjs
 */
require('reflect-metadata');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');

const DIST = path.join(__dirname, '..', '..', 'dist');
let PaymentMethodsService, AppError;
try {
  ({ PaymentMethodsService } = require(path.join(DIST, 'payment-methods', 'payment-methods.service.js')));
  ({ AppError } = require(path.join(DIST, 'common', 'errors.js')));
} catch (err) {
  throw new Error(
    `No se encontró dist/ compilado (${err.message}). Corre "npm run build" antes de este test.`,
  );
}

const USER = {
  id: 'user-1',
  username: 'admin',
  fullName: 'Administradora',
  roleId: 'role-admin',
  permissions: [],
  active: true,
  deactivatedAt: null,
};

/** Tx (y Prisma raíz) en memoria: sólo lo que `PaymentMethodsService` toca. */
function fakeDb({ methods = [], salePayments = 0, orderDeposits = 0, closureLines = 0 } = {}) {
  const byId = new Map(methods.map((m) => [m.id, { ...m }]));

  const tx = {
    paymentMethod: {
      findUnique: async ({ where }) => (byId.has(where.id) ? { ...byId.get(where.id) } : null),
      findFirst: async ({ where }) => {
        for (const row of byId.values()) {
          if (row.name === where.name && row.id !== where.id.not) return { ...row };
        }
        return null;
      },
      create: async ({ data }) => {
        const row = { ...data };
        byId.set(row.id, row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = { ...byId.get(where.id), ...data };
        byId.set(where.id, row);
        return row;
      },
      delete: async ({ where }) => {
        const row = byId.get(where.id);
        byId.delete(where.id);
        return row;
      },
    },
    salePayment: { count: async () => salePayments },
    orderDeposit: { count: async () => orderDeposits },
    closureMethod: { count: async () => closureLines },
  };

  return {
    tx,
    prisma: { $transaction: async (cb) => cb(tx) },
  };
}

function makeService(dbOpts) {
  const { prisma, tx } = fakeDb(dbOpts);
  const audit = { log: async () => {} };
  const tombstones = { clear: async () => {}, record: async () => {} };
  return { service: new PaymentMethodsService(prisma, audit, tombstones), tx };
}

test('create: id semántico derivado del nombre cuando no llega id', async () => {
  const { service } = makeService({});
  const row = await service.create(USER, { name: 'Efectivo USD', currency: 'USD' });
  assert.equal(row.id, 'pm-efectivo-usd');
  assert.equal(row.currency, 'USD');
  assert.equal(row.active, true);
});

test('create: idempotente por id — si ya existe, devuelve la existente sin tocarla', async () => {
  const { service } = makeService({
    methods: [{ id: 'pm-x', name: 'Efectivo', currency: 'USD', requiresReference: false, active: true, position: 0, rev: 3 }],
  });
  const row = await service.create(USER, { id: 'pm-x', name: 'Otro nombre', currency: 'BS' });
  assert.equal(row.name, 'Efectivo'); // no se sobreescribió
  assert.equal(row.rev, 3);
});

test('create: nombre repetido (otro id) ⇒ 409 conflict', async () => {
  const { service } = makeService({
    methods: [{ id: 'pm-a', name: 'Efectivo', currency: 'USD', requiresReference: false, active: true, position: 0 }],
  });
  await assert.rejects(
    () => service.create(USER, { name: 'Efectivo', currency: 'BS' }),
    (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, 'conflict');
      return true;
    },
  );
});

test('update: cambiar de moneda sin historial se permite', async () => {
  const { service } = makeService({
    methods: [{ id: 'pm-a', name: 'Zelle', currency: 'USD', requiresReference: true, active: true, position: 0 }],
  });
  const row = await service.update(USER, 'pm-a', { currency: 'BS' });
  assert.equal(row.currency, 'BS');
});

test('update: cambiar de moneda con historial ⇒ 409 has_history', async () => {
  const { service } = makeService({
    methods: [{ id: 'pm-a', name: 'Zelle', currency: 'USD', requiresReference: true, active: true, position: 0 }],
    salePayments: 2,
  });
  await assert.rejects(
    () => service.update(USER, 'pm-a', { currency: 'BS' }),
    (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, 'has_history');
      assert.equal(err.details?.salePayments, 2);
      return true;
    },
  );
});

test('update: nombre repetido (otro id) ⇒ 409 conflict', async () => {
  const { service } = makeService({
    methods: [
      { id: 'pm-a', name: 'Efectivo', currency: 'USD', requiresReference: false, active: true, position: 0 },
      { id: 'pm-b', name: 'Zelle', currency: 'USD', requiresReference: true, active: true, position: 1 },
    ],
  });
  await assert.rejects(
    () => service.update(USER, 'pm-b', { name: 'Efectivo' }),
    (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, 'conflict');
      return true;
    },
  );
});

test('remove: sin historial, se borra', async () => {
  const { service, tx } = makeService({
    methods: [{ id: 'pm-a', name: 'Efectivo', currency: 'USD', requiresReference: false, active: true, position: 0 }],
  });
  await service.remove(USER, 'pm-a');
  assert.equal(await tx.paymentMethod.findUnique({ where: { id: 'pm-a' } }), null);
});

test('remove: con abonos en uso ⇒ 409 has_history, no se borra', async () => {
  const { service, tx } = makeService({
    methods: [{ id: 'pm-a', name: 'Efectivo', currency: 'USD', requiresReference: false, active: true, position: 0 }],
    orderDeposits: 1,
  });
  await assert.rejects(
    () => service.remove(USER, 'pm-a'),
    (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, 'has_history');
      assert.equal(err.details?.orderDeposits, 1);
      return true;
    },
  );
  assert.notEqual(await tx.paymentMethod.findUnique({ where: { id: 'pm-a' } }), null);
});

test('remove: id inexistente ⇒ not_found', async () => {
  const { service } = makeService({});
  await assert.rejects(
    () => service.remove(USER, 'pm-fantasma'),
    (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, 'not_found');
      return true;
    },
  );
});
