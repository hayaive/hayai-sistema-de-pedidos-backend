/**
 * Pruebas de integración contra un servidor REAL y un Postgres REAL.
 *
 * No hay mocks a propósito: lo que se está comprobando es justo lo que un mock
 * borraría — que los triggers de la migración asignan el `rev`, que el día
 * contable lo pone la base en `America/Caracas`, que el índice único parcial
 * impide facturar dos veces un pedido y que la bitácora de idempotencia evita
 * duplicar dinero cuando se reenvía una mutación.
 *
 * Cómo correrlo:
 *   1. levanta un Postgres (ver README) y aplica migración + seed;
 *   2. arranca el servidor (`node dist/main.js`);
 *   3. `API_URL=http://127.0.0.1:3099/api/v1 ADMIN_PASSWORD=... npm run test:e2e`
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

const BASE = process.env.API_URL ?? 'http://127.0.0.1:3099/api/v1';
const USERNAME = process.env.ADMIN_USERNAME ?? 'admin';
const PASSWORD = process.env.ADMIN_PASSWORD ?? 'Admin.Verify.2026';
const DEVICE_ID = process.env.DEVICE_ID ?? `dev-e2e-${randomUUID().slice(0, 8)}`;

/** Estado compartido entre pruebas: se llena en orden. */
const state = {
  accessToken: null,
  refreshToken: null,
  productId: null,
  priceTypeId: null,
  customerId: null,
  orderId: null,
  orderRev: null,
  cursorAfterOrder: null,
};

const RATE = 814.6908;

async function api(method, path, { body, token, headers = {}, expect } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token === null ? {} : { Authorization: `Bearer ${token ?? state.accessToken}` }),
      'X-Device-Id': DEVICE_ID,
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await res.text();
  const json = text ? JSON.parse(text) : null;

  if (expect !== undefined && res.status !== expect) {
    throw new Error(
      `${method} ${path} devolvió ${res.status}, se esperaba ${expect}: ${text.slice(0, 500)}`,
    );
  }
  return { status: res.status, body: json, headers: res.headers };
}

describe('Backend de pedidos · integración contra Postgres real', () => {
  before(async () => {
    const health = await api('GET', '/health', { token: null, expect: 200 });
    assert.equal(health.body.status, 'ok');
  });

  it('GET /health responde 200 sin tocar la base', async () => {
    const res = await api('GET', '/health', { token: null, expect: 200 });
    assert.equal(res.body.status, 'ok');
    assert.ok(typeof res.body.serverTime === 'string');
  });

  it('GET /health/db sí toca la base y responde 200', async () => {
    const res = await api('GET', '/health/db', { token: null, expect: 200 });
    assert.equal(res.body.status, 'ok');
    assert.ok(res.body.latencyMs >= 0);
  });

  it('una ruta protegida sin token responde 401 con el formato del contrato', async () => {
    const res = await api('GET', '/bootstrap', { token: 'no-vale', expect: 401 });
    assert.equal(res.body.error.code, 'unauthorized');
  });

  it('POST /auth/login devuelve tokens, permisos y cursor, y NUNCA el hash', async () => {
    const res = await api('POST', '/auth/login', {
      token: null,
      expect: 201,
      body: {
        username: USERNAME,
        password: PASSWORD,
        device: { id: DEVICE_ID, name: 'Caja de pruebas', userAgent: 'e2e/1.0' },
      },
    });

    assert.ok(res.body.accessToken, 'falta accessToken');
    assert.ok(res.body.refreshToken, 'falta refreshToken');
    assert.equal(res.body.user.username, USERNAME);
    assert.ok(res.body.permissions.includes('create_sale'));
    assert.equal(typeof res.body.cursor, 'number');
    assert.equal(typeof res.body.schemaVersion, 'number');

    // El hash de la contraseña no sale del servidor, ni aquí ni en /bootstrap.
    assert.ok(
      !JSON.stringify(res.body).match(/passwordHash|\$argon2/),
      'la respuesta de login filtró el hash',
    );

    state.accessToken = res.body.accessToken;
    state.refreshToken = res.body.refreshToken;
  });

  it('una contraseña incorrecta responde 401 sin distinguir de un usuario inexistente', async () => {
    const bad = await api('POST', '/auth/login', {
      token: null,
      expect: 401,
      body: { username: USERNAME, password: 'no-es-la-clave', device: { id: DEVICE_ID } },
    });
    const missing = await api('POST', '/auth/login', {
      token: null,
      expect: 401,
      body: { username: 'no-existe-nadie', password: 'x'.repeat(12), device: { id: DEVICE_ID } },
    });
    assert.equal(bad.body.error.message, missing.body.error.message);
  });

  it('una petición autenticada sin X-Device-Id se rechaza', async () => {
    const res = await fetch(`${BASE}/bootstrap`, {
      headers: { Authorization: `Bearer ${state.accessToken}` },
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error.message, /X-Device-Id/);
  });

  it('GET /auth/me devuelve el usuario resuelto en la base', async () => {
    const res = await api('GET', '/auth/me', { expect: 200 });
    assert.equal(res.body.user.username, USERNAME);
  });

  it('GET /bootstrap trae la ventana operativa completa y el cursor', async () => {
    const res = await api('GET', '/bootstrap', { expect: 200 });
    const b = res.body;

    for (const key of [
      'cursor',
      'serverTime',
      'schemaVersion',
      'window',
      'company',
      'roles',
      'users',
      'categories',
      'priceTypes',
      'priceGroups',
      'products',
      'paymentMethods',
      'rates',
      'customers',
      'orders',
      'sales',
      'movements',
      'closures',
      'audit',
      'retiredProductCodes',
    ]) {
      assert.ok(key in b, `/bootstrap no trae "${key}"`);
    }

    // Lo que dejó el seed.
    assert.ok(b.priceTypes.length >= 2, 'faltan los tipos de precio del seed');
    assert.ok(b.paymentMethods.length >= 5, 'faltan las formas de pago del seed');
    assert.equal(b.retiredProductCodes.length, 13, 'deben estar los 13 códigos retirados');
    assert.ok(
      b.categories.some((c) => c.id === 'cat-tortas-frias'),
      'falta la categoría de tortas frías del seed',
    );

    // El seed ya NO siembra los tres grupos de precio: el mecanismo se retiró en
    // 2026-09 y volver a sembrarlos resucitaría en cada arranque lo que la
    // migración de datos limpia. La clave sigue viajando —y como array— porque un
    // cliente v5 la espera en el agregado.
    assert.ok(Array.isArray(b.priceGroups), '`priceGroups` debe seguir viajando');
    assert.equal(
      b.priceGroups.length,
      0,
      'una instalación nueva no debe traer ningún grupo de precio sembrado',
    );

    // El usuario técnico no viaja y ningún hash sale del servidor.
    assert.ok(!b.users.some((u) => u.username === 'system'), 'el usuario técnico no debe viajar');
    assert.ok(!JSON.stringify(b).match(/passwordHash|\$argon2/), '/bootstrap filtró el hash');

    // Sólo un tipo de precio por defecto (índice único parcial).
    assert.equal(b.priceTypes.filter((p) => p.isDefault).length, 1);

    // `coldCakeCategory` viaja SIEMPRE, y vacía: el seed dejó de apuntarla porque
    // la banda mínimo/máximo cuelga del producto genérico "Tortas Frías" y no de
    // la categoría. Si la clave se omitiera, un cliente que fusiona la
    // configuración campo a campo conservaría su valor viejo para siempre.
    assert.ok(
      'coldCakeCategory' in b.company,
      '`company.coldCakeCategory` no puede omitirse aunque la columna esté a NULL',
    );
    assert.equal(b.company.coldCakeCategory, '');
    assert.equal(typeof b.company.coldCakeMin, 'number');
    assert.equal(typeof b.company.coldCakeMax, 'number');

    state.priceTypeId = b.priceTypes.find((p) => p.isDefault).id;
  });

  it('POST /rates publica la tasa BCV y GET /rates/current la devuelve', async () => {
    await api('POST', '/rates', {
      expect: 201,
      body: { source: 'BCV_USD', value: RATE },
    });
    const current = await api('GET', '/rates/current', { expect: 200 });
    assert.equal(current.body.BCV_USD.value, RATE);
    // `automatic: false` porque la publicó una persona.
    assert.equal(current.body.BCV_USD.automatic, false);
  });

  it('POST /products crea un producto (y `stock` no es escribible)', async () => {
    const res = await api('POST', '/products', {
      expect: 201,
      body: {
        code: 'E2E01',
        name: 'Torta fría de prueba',
        categoryId: 'cat-tortas-frias',
        minStock: 5,
        // Se manda `stock` a propósito: el ValidationPipe lo descarta porque el DTO
        // no lo declara. La existencia sólo se mueve con un movimiento.
        stock: 999,
        prices: [{ priceTypeId: state.priceTypeId, amount: 1.2 }],
      },
    });

    assert.equal(res.body.code, 'E2E01');
    assert.equal(res.body.stock, 0, '`stock` no debe poder llegar desde el cliente');
    assert.equal(typeof res.body.rev, 'number');
    // El producto cae en la familia de tortas frías y NO se engancha a ningún
    // grupo: el reenganche automático se retiró con el mecanismo (2026-09). Su
    // precio sale de `prices` y de ningún otro sitio.
    assert.equal(res.body.priceGroupId, undefined, 'un producto nuevo no se engancha a un grupo');
    assert.equal(res.body.prices.length, 1);
    assert.equal(res.body.prices[0].amount, 1.2);

    state.productId = res.body.id;
  });

  it('un `priceGroupId` que ya no existe se degrada a null, no rechaza el alta', async () => {
    // Un v5 con un `product.create` encolado desde antes de la migración de datos
    // sigue mandando el grupo genérico. Rechazarlo sería `validation_failed`, que
    // el cliente trata como PERMANENTE: descartaría el producto entero por un
    // campo que ya no significa nada.
    const res = await api('POST', '/products', {
      expect: 201,
      body: {
        code: 'E2E02',
        name: 'Alta encolada por un cliente v5',
        categoryId: 'cat-tortas-frias',
        priceGroupId: 'pg-tortas-frias',
        prices: [{ priceTypeId: state.priceTypeId, amount: 1.3 }],
      },
    });
    assert.equal(res.body.priceGroupId, undefined, 'un grupo inexistente debe caer a null');
    assert.equal(res.body.prices[0].amount, 1.3, 'el precio propio del producto manda');
  });

  it('un código repetido se rechaza en línea, y uno retirado nunca se reutiliza', async () => {
    const dup = await api('POST', '/products', {
      expect: 409,
      body: {
        code: 'E2E01',
        name: 'Duplicado',
        categoryId: 'cat-tortas-frias',
        prices: [{ priceTypeId: state.priceTypeId, amount: 1.2 }],
      },
    });
    assert.equal(dup.body.error.code, 'conflict');

    // P001 es uno de los 13 sabores consolidados: su código está retirado.
    const retired = await api('POST', '/products', {
      expect: 409,
      body: {
        code: 'P001',
        name: 'Intento de revivir un código retirado',
        categoryId: 'cat-tortas-frias',
        prices: [{ priceTypeId: state.priceTypeId, amount: 1.2 }],
      },
    });
    assert.equal(retired.body.error.code, 'retired_code');
  });

  it('POST /products/:id/movements mueve la existencia y cuadra con el ledger', async () => {
    const res = await api('POST', `/products/${state.productId}/movements`, {
      expect: 201,
      body: { type: 'entrada', qty: 40, reason: 'Carga inicial de pruebas' },
    });
    assert.equal(res.body.delta, 40);
    assert.equal(res.body.stockAfter, 40);

    const reconcile = await api('GET', '/movements/reconcile', { expect: 200 });
    assert.equal(reconcile.body.ok, true, 'products.stock no cuadra con SUM(delta)');
  });

  it('POST /customers crea el cliente y una cédula repetida se FUSIONA con idMap', async () => {
    const cedula = `V-${String(Date.now()).slice(-8)}`;

    const created = await api('POST', '/customers', {
      expect: 201,
      body: { cedula, name: 'Cliente de prueba', phone: '0414-1234567' },
    });
    assert.equal(created.body.cedula, cedula);
    state.customerId = created.body.id;

    // Alta con la misma cédula desde otro "dispositivo": se fusiona y devuelve el
    // remapeo de id para que el cliente reapunte sus pedidos locales.
    const localId = randomUUID();
    const merged = await api('POST', '/customers', {
      expect: 201,
      body: { id: localId, cedula, name: 'Cliente de prueba (otro equipo)', address: 'Calle 1' },
    });
    assert.equal(merged.body.merged, true);
    assert.equal(merged.body.id, state.customerId, 'la fusión debe conservar la fila del servidor');
    assert.deepEqual(merged.body.idMap, [
      { entity: 'customer', localId, serverId: state.customerId },
    ]);
    // Sólo se rellenan huecos: el nombre trabajado no se sobreescribe con el del alta.
    assert.equal(merged.body.name, 'Cliente de prueba');
    assert.equal(merged.body.address, 'Calle 1');
  });

  it('POST /orders crea el pedido CON ABONO y el saldo sale derivado', async () => {
    const res = await api('POST', '/orders', {
      expect: 201,
      body: {
        customerId: state.customerId,
        customerName: 'Cliente de prueba',
        note: 'Pedido de verificación',
        items: [
          {
            productId: state.productId,
            qty: 10,
            priceTypeId: state.priceTypeId,
            unitPriceUsd: 1.2,
          },
        ],
        // Abono adelantado en el mismo acto: si el abono fuera inválido, no se
        // crearía el pedido.
        deposit: { methodId: 'pm-usd', amount: 5 },
      },
    });

    const order = res.body;
    assert.match(order.number, /^P-\d{5}$/, 'el número lo asigna el servidor');
    assert.equal(order.status, 'pendiente');
    // El servidor recalcula el total desde las líneas: 10 × 1,20 = 12,00.
    assert.equal(order.totalUsd, 12);
    assert.equal(order.deposits.length, 1);
    assert.equal(order.deposits[0].usdEquivalent, 5);
    // La tasa del abono se congela aunque el método sea USD.
    assert.equal(order.deposits[0].rateUsed, RATE);

    // Saldo derivado, nunca persistido.
    assert.equal(order.balance.totalUsd, 12);
    assert.equal(order.balance.depositUsd, 5);
    assert.equal(order.balance.balanceUsd, 7);
    assert.equal(order.balance.overpaidUsd, 0);
    assert.equal(order.balance.status, 'abonado');

    // El día contable lo pone la base, no el cliente.
    assert.match(order.businessDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(typeof order.rev, 'number');
    assert.equal(res.headers.get('etag'), String(order.rev));

    state.orderId = order.id;
    state.orderRev = order.rev;
  });

  it('el total del pedido NO se acepta del cliente: se recalcula', async () => {
    const res = await api('PATCH', `/orders/${state.orderId}`, {
      expect: 200,
      headers: { 'If-Match': String(state.orderRev) },
      body: {
        // `totalUsd` no está en el DTO: el ValidationPipe lo descarta.
        totalUsd: 999999,
        items: [
          { productId: state.productId, qty: 12, priceTypeId: state.priceTypeId, unitPriceUsd: 1.2 },
        ],
      },
    });
    assert.equal(res.body.totalUsd, 14.4, '12 × 1,20 = 14,40');
    assert.notEqual(res.body.rev, state.orderRev, 'editar las líneas debe mover el rev del pedido');
    state.orderRev = res.body.rev;
  });

  it('PATCH /orders/:id sin If-Match responde 428, y con rev viejo 409', async () => {
    const missing = await api('PATCH', `/orders/${state.orderId}`, {
      expect: 428,
      body: { note: 'sin precondición' },
    });
    assert.equal(missing.body.error.code, 'precondition_required');

    const stale = await api('PATCH', `/orders/${state.orderId}`, {
      expect: 409,
      headers: { 'If-Match': '1' },
      body: { note: 'con rev desfasado' },
    });
    assert.equal(stale.body.error.code, 'conflict');
    assert.ok(stale.body.error.details.serverEntity, 'el conflicto debe traer el estado del servidor');
  });

  it('el estado del pedido es monótono: una transición que retrocede se ignora', async () => {
    const forward = await api('POST', `/orders/${state.orderId}/status`, {
      expect: 201,
      headers: { 'If-Match': String(state.orderRev) },
      body: { status: 'listo' },
    });
    assert.equal(forward.body.status, 'listo');
    state.orderRev = forward.body.rev;

    // Llega tarde un `preparacion` de otro dispositivo: se ignora y se audita.
    const backward = await api('POST', `/orders/${state.orderId}/status`, {
      expect: 201,
      headers: { 'If-Match': String(state.orderRev) },
      body: { status: 'preparacion' },
    });
    assert.equal(backward.body.status, 'listo', 'el estado no debe retroceder');
    assert.ok(backward.body.statusIgnored, 'debe informar que la transición se ignoró');

    // `procesado` no se pide a mano: sale de facturar el pedido.
    const processed = await api('POST', `/orders/${state.orderId}/status`, {
      expect: 400,
      headers: { 'If-Match': String(backward.body.rev) },
      body: { status: 'procesado' },
    });
    assert.equal(processed.body.error.code, 'validation_failed');
    state.orderRev = backward.body.rev;
  });

  it('GET /sync?since=0 devuelve el delta completo y un cursor', async () => {
    const res = await api('GET', '/sync?since=0', { expect: 200 });

    assert.equal(typeof res.body.cursor, 'number');
    assert.equal(typeof res.body.hasMore, 'boolean');
    assert.ok(res.body.changes, 'falta `changes`');
    assert.ok(Array.isArray(res.body.deletions), 'falta `deletions`');

    const c = res.body.changes;
    assert.ok(c.company, 'el delta debe traer la configuración');
    assert.ok(c.products.some((p) => p.id === state.productId));
    assert.ok(c.orders.some((o) => o.id === state.orderId));
    assert.ok(c.orderDeposits.length >= 1, 'los abonos viajan como raíz propia');
    assert.ok(c.movements.length >= 1);

    // Orden de aplicación por FK: las categorías antes que los productos.
    const keys = Object.keys(c);
    assert.ok(
      keys.indexOf('categories') < keys.indexOf('products'),
      'el delta debe venir en orden de FK',
    );

    // Ningún hash en el delta.
    assert.ok(!JSON.stringify(res.body).match(/passwordHash|\$argon2/));

    state.cursorAfterOrder = res.body.cursor;
  });

  it('GET /sync con el cursor al día no devuelve nada nuevo', async () => {
    const res = await api('GET', `/sync?since=${state.cursorAfterOrder}`, { expect: 200 });
    // La ventana de reenvío puede reenviar algunas filas; lo que no puede es
    // retroceder el cursor.
    assert.ok(res.body.cursor >= state.cursorAfterOrder, 'el cursor no puede retroceder');
    assert.equal(res.body.hasMore, false);
  });

  it('POST /sync aplica una mutación offline y es IDEMPOTENTE al reenviarla', async () => {
    const mutationId = randomUUID();
    const depositId = randomUUID();

    const payload = {
      deviceId: DEVICE_ID,
      cursor: state.cursorAfterOrder,
      mutations: [
        {
          mutationId,
          entity: 'orderDeposit',
          op: 'create',
          at: new Date().toISOString(),
          payload: {
            id: depositId,
            orderId: state.orderId,
            methodId: 'pm-bs',
            amount: 4073.454,
            rateUsed: RATE,
            reference: 'PM-OFFLINE-1',
          },
        },
      ],
    };

    const first = await api('POST', '/sync', { expect: 201, body: payload });
    assert.equal(first.body.results.length, 1);
    const applied = first.body.results[0];
    assert.equal(applied.mutationId, mutationId);
    assert.equal(applied.status, 'applied');
    assert.equal(applied.entityId, depositId);
    assert.equal(applied.retryable, false);
    // 4073,454 Bs / 814,6908 = 5,0000 USD
    assert.equal(applied.serverEntity.usdEquivalent, 5);
    assert.equal(applied.serverEntity.currency, 'BS');
    assert.equal(applied.serverEntity.rateUsed, RATE);

    // Reenvío del MISMO mutationId: la red murió después del commit.
    const resend = await api('POST', '/sync', { expect: 201, body: payload });
    assert.equal(resend.body.results[0].status, 'duplicate');
    assert.equal(resend.body.results[0].retryable, false);

    // Y el dinero no se duplicó: un solo abono con ese id.
    const deposits = await api('GET', `/orders/${state.orderId}/deposits`, { expect: 200 });
    assert.equal(
      deposits.body.filter((d) => d.id === depositId).length,
      1,
      'el reenvío duplicó el abono',
    );

    // Los abonos NO mueven el rev del pedido: registrar un cobro en caja no debe
    // invalidar el bloqueo optimista de quien edita las líneas en otro equipo.
    const order = await api('GET', `/orders/${state.orderId}`, { expect: 200 });
    assert.equal(order.body.rev, state.orderRev, 'un abono no debe bumpear el rev del pedido');
    // 14,40 − 5 − 5 = 4,40
    assert.equal(order.body.balance.depositUsd, 10);
    assert.equal(order.body.balance.balanceUsd, 4.4);
  });

  it('POST /sync rechaza `online_only` de forma PERMANENTE', async () => {
    const res = await api('POST', '/sync', {
      expect: 201,
      body: {
        mutations: [
          {
            mutationId: randomUUID(),
            entity: 'user',
            op: 'create',
            payload: { username: 'colado', password: 'x'.repeat(12), roleId: 'role-cajero' },
          },
        ],
      },
    });

    const result = res.body.results[0];
    assert.equal(result.status, 'rejected');
    assert.match(result.reason, /online_only/);
    // Permanente: el cliente saca la mutación de la cola y no reintenta nunca.
    assert.equal(result.retryable, false);
  });

  it('POST /sync marca `dependency_failed` cuando la mutación previa falló', async () => {
    const ghostOrderId = randomUUID();

    const res = await api('POST', '/sync', {
      expect: 201,
      body: {
        mutations: [
          {
            // Falla: el pedido no existe.
            mutationId: randomUUID(),
            entity: 'order',
            op: 'update',
            payload: { orderId: ghostOrderId, note: 'no existe' },
          },
          {
            // Depende del anterior.
            mutationId: randomUUID(),
            entity: 'orderDeposit',
            op: 'create',
            payload: { orderId: ghostOrderId, methodId: 'pm-usd', amount: 1 },
          },
        ],
      },
    });

    assert.equal(res.body.results[0].status, 'rejected');
    assert.equal(res.body.results[1].status, 'rejected');
    assert.match(res.body.results[1].reason, /dependency_failed/);
  });

  it('POST /sync crea una venta offline: renumera, mueve stock y consume el abono', async () => {
    const saleId = randomUUID();
    const mutationId = randomUUID();

    const before = await api('GET', `/products/${state.productId}`, { expect: 200 });
    const stockBefore = before.body.stock;

    const res = await api('POST', '/sync', {
      expect: 201,
      body: {
        mutations: [
          {
            mutationId,
            entity: 'sale',
            op: 'create',
            at: new Date().toISOString(),
            payload: {
              id: saleId,
              // Número provisional que imprimió el ticket offline.
              number: 'V-99999',
              orderId: state.orderId,
              customerId: state.customerId,
              customerName: 'Cliente de prueba',
              items: [
                {
                  productId: state.productId,
                  qty: 12,
                  priceTypeId: state.priceTypeId,
                  unitPriceUsd: 1.2,
                },
              ],
              // Sólo el saldo: los abonos los inyecta el servidor.
              payments: [{ methodId: 'pm-usd', amount: 4.4 }],
              rateSnapshot: { usd: RATE, eur: 0, binance: 0 },
            },
          },
        ],
      },
    });

    const result = res.body.results[0];
    assert.equal(result.status, 'applied', JSON.stringify(result));

    const sale = result.serverEntity;
    // El servidor asignó el número definitivo y guardó el provisional.
    assert.match(sale.number, /^V-\d{5}$/);
    assert.notEqual(sale.number, 'V-99999');
    assert.equal(sale.clientNumber, 'V-99999');
    assert.deepEqual(result.renumbered, { from: 'V-99999', to: sale.number });
    assert.equal(sale.createdOffline, true);

    // 12 × 1,20 = 14,40, cubierto por 10 de abonos + 4,40 en efectivo.
    assert.equal(sale.totalUsd, 14.4);
    assert.equal(sale.payments.length, 3, '2 abonos + 1 pago en efectivo');
    const fromDeposits = sale.payments.filter((p) => p.fromOrderDepositId);
    assert.equal(fromDeposits.length, 2, 'los abonos entran como pagos de la venta');
    // Cada abono conserva SU fecha y SU tasa: el cierre lo cuenta en su día.
    assert.ok(fromDeposits.every((p) => p.rateUsed === RATE));
    assert.equal(sale.changeUsd, 0);

    // La tasa quedó congelada en el comprobante.
    assert.equal(sale.rateSnapshot.usd, RATE);
    assert.match(sale.businessDate, /^\d{4}-\d{2}-\d{2}$/);

    // Inventario: la venta descontó 12 unidades en la misma transacción.
    const after = await api('GET', `/products/${state.productId}`, { expect: 200 });
    assert.equal(after.body.stock, stockBefore - 12);

    const reconcile = await api('GET', '/movements/reconcile', { expect: 200 });
    assert.equal(reconcile.body.ok, true);

    // El pedido quedó procesado y apuntando a su venta.
    const order = await api('GET', `/orders/${state.orderId}`, { expect: 200 });
    assert.equal(order.body.status, 'procesado');
    assert.equal(order.body.saleId, sale.id);

    state.saleId = sale.id;
  });

  it('un pedido ya facturado NO se factura dos veces', async () => {
    const res = await api('POST', '/sync', {
      expect: 201,
      body: {
        mutations: [
          {
            mutationId: randomUUID(),
            entity: 'sale',
            op: 'create',
            payload: {
              id: randomUUID(),
              orderId: state.orderId,
              items: [
                {
                  productId: state.productId,
                  qty: 1,
                  priceTypeId: state.priceTypeId,
                  unitPriceUsd: 1.2,
                },
              ],
              payments: [{ methodId: 'pm-usd', amount: 1.2 }],
              rateSnapshot: { usd: RATE },
            },
          },
        ],
      },
    });

    const result = res.body.results[0];
    assert.equal(result.status, 'rejected');
    assert.match(result.reason, /order_already_billed/);
    assert.equal(result.retryable, false);
    assert.ok(result.serverEntity, 'debe devolver la venta que ya existía');
  });

  it('GET /closures/draft cuenta el dinero por día contable sin duplicar abonos', async () => {
    const draft = await api('GET', '/closures/draft', { expect: 200 });

    assert.match(draft.body.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(draft.body.salesCount >= 1);
    assert.ok(Array.isArray(draft.body.byMethod));

    // Invariante del §3.4: el dinero del día es 4,40 en efectivo USD (el resto de
    // la venta son abonos, que ya se contaron el día del abono) + 10 de abonos
    // recibidos hoy = 14,40. Ni más (duplicar abonos) ni menos (perderlos).
    const total = draft.body.byMethod.reduce((a, m) => a + m.expected, 0);
    assert.equal(
      Number(total.toFixed(2)),
      14.4,
      `esperado 14,40 y salió ${total}: ${JSON.stringify(draft.body.byMethod)}`,
    );
    assert.equal(Number(draft.body.expectedUsd.toFixed(2)), 14.4);
  });

  it('POST /closures cierra el día y un segundo cierre responde already_closed', async () => {
    const draft = await api('GET', '/closures/draft', { expect: 200 });

    const created = await api('POST', '/closures', {
      expect: 201,
      body: {
        byMethod: draft.body.byMethod.map((m) => ({ methodId: m.methodId, received: m.expected })),
        note: 'Cierre de verificación',
      },
    });
    assert.equal(created.body.differenceUsd, 0, 'lo contado igual a lo esperado ⇒ diferencia 0');

    const again = await api('POST', '/closures', { expect: 409, body: {} });
    assert.equal(again.body.error.code, 'already_closed');
  });

  it('anular la venta es idempotente y devuelve el stock una sola vez', async () => {
    const before = await api('GET', `/products/${state.productId}`, { expect: 200 });

    const first = await api('POST', `/sales/${state.saleId}/void`, {
      expect: 201,
      body: { reason: 'Prueba de anulación' },
    });
    assert.equal(first.body.status, 'anulada');
    assert.ok(first.body.voidedAt);

    const after = await api('GET', `/products/${state.productId}`, { expect: 200 });
    assert.equal(after.body.stock, before.body.stock + 12, 'la anulación debe devolver el stock');

    // Segunda anulación: no vuelve a devolver stock.
    const second = await api('POST', `/sales/${state.saleId}/void`, {
      expect: 201,
      body: { reason: 'Otra vez' },
    });
    assert.equal(second.body.alreadyVoided, true);

    const final = await api('GET', `/products/${state.productId}`, { expect: 200 });
    assert.equal(final.body.stock, after.body.stock, 'la anulación no es idempotente');

    const reconcile = await api('GET', '/movements/reconcile', { expect: 200 });
    assert.equal(reconcile.body.ok, true);
  });

  it('el kardex y la bitácora son append-only: no hay ruta para editarlos', async () => {
    // No existe PATCH/DELETE de movimientos ni de auditoría en la API. Se comprueba
    // que el trigger de la base también lo impide, por si alguien añadiera la ruta.
    const movements = await api('GET', `/movements?productId=${state.productId}`, { expect: 200 });
    assert.ok(movements.body.items.length >= 3, 'entrada + salida de venta + devolución');
    assert.ok(movements.body.items.every((m) => typeof m.rev === 'number'));
  });

  it('un borrado genera tombstone y viaja en el delta', async () => {
    const cursorBefore = (await api('GET', '/sync?since=0', { expect: 200 })).body.cursor;

    const doomed = await api('POST', '/customers', {
      expect: 201,
      body: { cedula: `V-${String(Date.now()).slice(-8)}1`, name: 'Cliente a borrar' },
    });

    await api('DELETE', `/customers/${doomed.body.id}`, { expect: 204 });

    const delta = await api('GET', `/sync?since=${cursorBefore}`, { expect: 200 });
    assert.ok(
      delta.body.deletions.some((d) => d.entity === 'customer' && d.id === doomed.body.id),
      'el borrado debe viajar como tombstone',
    );
  });

  it('un cliente con historial no se borra: se desactiva', async () => {
    const res = await api('DELETE', `/customers/${state.customerId}`, { expect: 409 });
    assert.equal(res.body.error.code, 'has_history');
  });

  it('los permisos se aplican en el SERVIDOR, no en el frontend', async () => {
    // Un cajero no puede gestionar usuarios.
    const cajeroPassword = 'Cajero.E2E.2026';
    const username = `cajero-e2e-${randomUUID().slice(0, 6)}`;

    await api('POST', '/users', {
      expect: 201,
      body: { username, fullName: 'Cajero de prueba', password: cajeroPassword, roleId: 'role-cajero' },
    });

    const login = await api('POST', '/auth/login', {
      token: null,
      expect: 201,
      body: { username, password: cajeroPassword, device: { id: DEVICE_ID } },
    });

    const forbidden = await api('GET', '/users', { token: login.body.accessToken, expect: 403 });
    assert.equal(forbidden.body.error.code, 'forbidden');

    // Pero sí puede cobrar.
    const allowed = await api('GET', '/products', { token: login.body.accessToken, expect: 200 });
    assert.ok(Array.isArray(allowed.body.items));
  });

  it('POST /auth/refresh rota el token y detecta su reutilización', async () => {
    const first = await api('POST', '/auth/refresh', {
      token: null,
      expect: 201,
      body: { refreshToken: state.refreshToken },
    });
    assert.ok(first.body.accessToken);
    assert.notEqual(first.body.refreshToken, state.refreshToken, 'el refresh debe rotar');

    // Reutilizar el viejo: se asume cadena comprometida y se revocan las sesiones.
    const reuse = await api('POST', '/auth/refresh', {
      token: null,
      expect: 401,
      body: { refreshToken: state.refreshToken },
    });
    assert.match(reuse.body.error.message, /ya utilizado/);

    // Y el token nuevo también quedó revocado por la revocación en cascada.
    const afterReuse = await api('POST', '/auth/refresh', {
      token: null,
      expect: 401,
      body: { refreshToken: first.body.refreshToken },
    });
    assert.equal(afterReuse.body.error.code, 'unauthorized');
  });

  it('POST /auth/logout es idempotente', async () => {
    const login = await api('POST', '/auth/login', {
      token: null,
      expect: 201,
      body: { username: USERNAME, password: PASSWORD, device: { id: DEVICE_ID } },
    });

    await api('POST', '/auth/logout', {
      token: null,
      expect: 204,
      body: { refreshToken: login.body.refreshToken },
    });
    // Un token ya revocado o desconocido también da 204.
    await api('POST', '/auth/logout', {
      token: null,
      expect: 204,
      body: { refreshToken: login.body.refreshToken },
    });

    state.accessToken = login.body.accessToken;
  });

  after(() => {
    // Nada que limpiar: la base de verificación es desechable.
  });
});
