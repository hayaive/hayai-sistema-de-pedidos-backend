/**
 * Unitarios de `ProductsService.create` para el recode de códigos tomados o
 * retirados (§5 ARCHITECTURE.md, allowRecode). No usa Prisma real: la vía de
 * sync (`allowRecode: true`) sólo ejercita ramas de negocio (qué código
 * termina usando el producto, qué se recodifica y qué se rechaza), no
 * triggers de la base — eso ya lo cubre `test/api.e2e.mjs` a propósito sin
 * mocks. Por eso aquí sí tiene sentido una transacción falsa en memoria.
 *
 * `ProductsService` usa decoradores de Nest (`@Injectable`, parámetros con
 * modificador de acceso) que el *type-stripping* nativo de `node --test` no
 * soporta al importar TypeScript directo. Por eso este archivo requiere el
 * JS ya compilado por `nest build` (`.cjs`, para que corra como CommonJS
 * pase lo que pase el `"type"` de `test/unit/package.json`):
 *
 *   npm run build
 *   node --test test/unit/products-service-recode.test.cjs
 */
require('reflect-metadata'); // los decoradores de Nest lo necesitan al cargar la clase
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');

const DIST = path.join(__dirname, '..', '..', 'dist');
let ProductsService, AppError;
try {
  ({ ProductsService } = require(path.join(DIST, 'catalog', 'products.service.js')));
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

const PRODUCT_CODE_CONFIG = { productCodePrefix: 'P', productCodeDigits: 3, productCodeStart: 1 };

/** Tx en memoria: sólo lo que `ProductsService.create` toca. */
function fakeTx({ categories = [], products = [], retired = [] }) {
  const categorySet = new Set(categories);
  const byId = new Map();
  const byCode = new Map();
  for (const p of products) {
    const row = { ...p, prices: [], comboItems: [] };
    byId.set(row.id, row);
    byCode.set(row.code, row);
  }
  const retiredByCode = new Map(retired.map((r) => [r.code, r]));

  return {
    category: {
      findUnique: async ({ where }) => (categorySet.has(where.id) ? { id: where.id } : null),
    },
    product: {
      findUnique: async ({ where }) => {
        if (where.id !== undefined) return byId.get(where.id) ?? null;
        if (where.code !== undefined) return byCode.get(where.code) ?? null;
        return null;
      },
      findMany: async () => [...byId.values()].map((p) => ({ code: p.code })),
      create: async ({ data }) => {
        const row = { ...data, prices: [], comboItems: [] };
        byId.set(row.id, row);
        byCode.set(row.code, row);
        return row;
      },
    },
    retiredProductCode: {
      findUnique: async ({ where }) => retiredByCode.get(where.code) ?? null,
      findMany: async () => [...retiredByCode.values()].map((r) => ({ code: r.code })),
    },
  };
}

function makeService() {
  return new ProductsService(
    {}, // PrismaService: no se usa, siempre se pasa opts.db
    { log: async () => {} }, // AuditService
    { clear: async () => {} }, // TombstonesService
    { settings: async () => ({ ...PRODUCT_CODE_CONFIG }) }, // CompanyService
  );
}

test('allowRecode + código retirado ⇒ se recodifica, no se rechaza', async () => {
  const service = makeService();
  const tx = fakeTx({ categories: ['cat-1'], retired: [{ code: 'P001', formerName: 'Torta vieja' }] });
  const dto = { code: 'P001', name: 'Producto nuevo', categoryId: 'cat-1' };

  const { product, renumbered } = await service.create(USER, dto, { db: tx, allowRecode: true });

  assert.equal(renumbered?.from, 'P001');
  assert.equal(renumbered?.to, 'P002'); // P001 retirado ⇒ ocupado; el siguiente libre es P002
  assert.equal(product.code, 'P002');
});

test('sin allowRecode, código retirado ⇒ rechazo 409 retired_code (comportamiento HTTP sin cambios)', async () => {
  const service = makeService();
  const tx = fakeTx({ categories: ['cat-1'], retired: [{ code: 'P001', formerName: 'Torta vieja' }] });
  const dto = { code: 'P001', name: 'Producto nuevo', categoryId: 'cat-1' };

  await assert.rejects(
    () => service.create(USER, dto, { db: tx }),
    (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, 'retired_code');
      return true;
    },
  );
});

test('allowRecode + código ya tomado por un producto vivo ⇒ se recodifica (regresión)', async () => {
  const service = makeService();
  const tx = fakeTx({
    categories: ['cat-1'],
    products: [{ id: 'prod-existente', code: 'P010', name: 'Ya existe' }],
  });
  const dto = { code: 'P010', name: 'Otro producto', categoryId: 'cat-1' };

  const { product, renumbered } = await service.create(USER, dto, { db: tx, allowRecode: true });

  assert.equal(renumbered?.from, 'P010');
  assert.equal(renumbered?.to, 'P001'); // P010 tomado; nada retirado; el piso (1) está libre
  assert.equal(product.code, 'P001');
});

test('sin allowRecode, código ya tomado ⇒ rechazo 409 conflict (comportamiento HTTP sin cambios)', async () => {
  const service = makeService();
  const tx = fakeTx({
    categories: ['cat-1'],
    products: [{ id: 'prod-existente', code: 'P010', name: 'Ya existe' }],
  });
  const dto = { code: 'P010', name: 'Otro producto', categoryId: 'cat-1' };

  await assert.rejects(
    () => service.create(USER, dto, { db: tx }),
    (err) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, 'conflict');
      return true;
    },
  );
});

test('código libre (ni tomado ni retirado) ⇒ se crea tal cual, sin renumbered', async () => {
  const service = makeService();
  const tx = fakeTx({ categories: ['cat-1'] });
  const dto = { code: 'P099', name: 'Producto libre', categoryId: 'cat-1' };

  const { product, renumbered } = await service.create(USER, dto, { db: tx, allowRecode: true });

  assert.equal(product.code, 'P099');
  assert.equal(renumbered, undefined);
});
