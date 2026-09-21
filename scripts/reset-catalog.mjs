// ─────────────────────────────────────────────────────────────────────────────
// Reinicio del catálogo y del histórico (operación manual, 2026-09).
//
//   node scripts/reset-catalog.mjs <catalogo.json> [--wipe] [--commit]
//
//  · Sin `--commit` es una SIMULACIÓN: hace todo dentro de la transacción,
//    imprime el resultado y termina en ROLLBACK.
//  · `--wipe` borra productos y todo el histórico que cuelga de ellos (ventas,
//    pedidos, abonos, kardex, cierres) y reinicia la numeración. Sin `--wipe`
//    sólo carga/actualiza el catálogo (upsert por id): es lo que hay que volver
//    a correr después de desplegar una migración que añade columnas de producto
//    (`bs_prices`, `price_band`), porque las columnas que el schema todavía no
//    tiene se omiten en vez de fallar.
//
// Usa el schema de `DATABASE_URL` (?schema=test | public), igual que la app.
//
// Por qué SQL directo y no la API: `DELETE /products/:id` rechaza con
// `has_history` cualquier producto vendido, y el kardex es append-only por
// trigger. Aquí se respeta lo que la API habría dejado a su paso: tombstones
// para que los dispositivos con cursor suelten lo borrado, y códigos retirados
// para que un ticket viejo impreso no resuelva a un producto nuevo.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(join(process.cwd(), 'package.json'));
const { Client } = require('pg');

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const WIPE = args.includes('--wipe');
const COMMIT = args.includes('--commit');
if (!file) {
  console.error('uso: node scripts/reset-catalog.mjs <catalogo.json> [--wipe] [--commit]');
  process.exit(2);
}

const PT_MAYOR = 'pt-mayor';
const PT_DETAL = 'pt-detal';

const catalog = JSON.parse(readFileSync(file, 'utf8'));
const log = (m) => console.log(`[reset] ${m}`);

const raw = process.env.DATABASE_URL;
if (!raw) throw new Error('Falta DATABASE_URL');
const url = new URL(raw);
const schema = url.searchParams.get('schema') || 'public';
url.searchParams.delete('schema');

const db = new Client({ connectionString: url.toString() });

async function count(table) {
  const r = await db.query(`SELECT count(*)::int AS n FROM "${table}"`);
  return r.rows[0].n;
}

async function hasColumn(table, column) {
  const r = await db.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
    [schema, table, column],
  );
  return r.rowCount > 0;
}

async function enumHas(type, label) {
  const r = await db.query(
    `SELECT 1 FROM pg_enum e
       JOIN pg_type t ON t.oid = e.enumtypid
       JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = $1 AND t.typname = $2 AND e.enumlabel = $3`,
    [schema, type, label],
  );
  return r.rowCount > 0;
}

/** Tombstone: se reinserta para que el trigger le dé un `rev` nuevo. */
async function tombstone(entity, ids) {
  if (!ids.length) return;
  await db.query(`DELETE FROM sync_deletions WHERE entity = $1::sync_entity AND entity_id = ANY($2)`, [
    entity,
    ids,
  ]);
  await db.query(
    `INSERT INTO sync_deletions (entity, entity_id)
     SELECT $1::sync_entity, unnest($2::text[])`,
    [entity, ids],
  );
}

async function wipe() {
  const newIds = new Set(catalog.products.map((p) => p.id));
  const newCodes = new Set(catalog.products.map((p) => p.code));

  const products = (await db.query(`SELECT id, code, name FROM products`)).rows;
  const orderIds = (await db.query(`SELECT id FROM orders`)).rows.map((r) => r.id);
  const closureIds = (await db.query(`SELECT id FROM daily_closures`)).rows.map((r) => r.id);

  // El kardex es append-only por trigger; sólo se levanta dentro de esta
  // transacción y para este DELETE.
  await db.query(`ALTER TABLE inventory_movements DISABLE TRIGGER inventory_movements_append_only`);
  await db.query(`DELETE FROM inventory_movements`);
  await db.query(`ALTER TABLE inventory_movements ENABLE TRIGGER inventory_movements_append_only`);

  // Orden impuesto por las FK RESTRICT: pagos → abonos → ventas → pedidos.
  for (const t of [
    'sale_payments',
    'sale_items',
    'order_deposits',
    'sales',
    'order_items',
    'orders',
    'closure_methods',
    'daily_closures',
    'combo_items',
    'product_prices',
    'products',
  ]) {
    const r = await db.query(`DELETE FROM "${t}"`);
    log(`${t}: ${r.rowCount} filas borradas`);
  }

  // Códigos retirados, igual que `ProductsService.remove`. Se excluyen los que
  // el catálogo nuevo vuelve a usar (si no, el trigger rechazaría la carga).
  const retire = products.filter((p) => !newCodes.has(p.code));
  for (const p of retire) {
    await db.query(
      `INSERT INTO retired_product_codes (code, former_name, former_product_id, reason)
       VALUES ($1, $2, $3, $4) ON CONFLICT (code) DO NOTHING`,
      [p.code, p.name, p.id, 'Reinicio de catálogo 2026-09'],
    );
  }
  log(`${retire.length} códigos retirados`);

  await tombstone(
    'product',
    products.map((p) => p.id).filter((id) => !newIds.has(id)),
  );
  await tombstone('order', orderIds);
  if (closureIds.length) {
    if (await enumHas('sync_entity', 'closure')) await tombstone('closure', closureIds);
    else log('AVISO: este schema no conoce el tombstone de cierre; los cierres se borraron sin él');
  }
  log(`tombstones: ${products.length} productos, ${orderIds.length} pedidos, ${closureIds.length} cierres`);

  // Histórico vacío ⇒ la numeración vuelve a empezar.
  await db.query(`UPDATE company_settings SET sale_next = 1, order_next = 1, updated_at = now()`);
  log('numeración de ventas y pedidos reiniciada');
}

async function load() {
  const withBsPrices = await hasColumn('products', 'bs_prices');
  if (!withBsPrices)
    log('AVISO: el schema no tiene products.bs_prices; los productos en Bs quedan con un solo precio (Mayor) hasta desplegar la migración y volver a correr la carga');

  for (const c of catalog.categories) {
    const clash = await db.query(`SELECT id FROM categories WHERE lower(name) = lower($1) AND id <> $2`, [
      c.name,
      c.id,
    ]);
    if (clash.rowCount) throw new Error(`La categoría "${c.name}" ya existe con otro id (${clash.rows[0].id})`);
    await db.query(
      `INSERT INTO categories (id, name, active) VALUES ($1, $2, true)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, active = true, updated_at = now()
       WHERE categories.name <> EXCLUDED.name OR NOT categories.active`,
      [c.id, c.name],
    );
    await db.query(`DELETE FROM sync_deletions WHERE entity = 'category' AND entity_id = $1`, [c.id]);
  }
  log(`${catalog.categories.length} categorías`);

  for (const p of catalog.products) {
    const bs = p.currency === 'BS';
    const cols = ['id', 'code', 'name', 'category_id', 'bs_only', 'bs_price', 'is_combo'];
    // `bs_price` es el del tipo predeterminado (Mayor); lo exige el CHECK de `bs_only`.
    const vals = [p.id, p.code, p.name, p.categoryId, bs, bs ? p.mayor : null, !!p.isCombo];
    if (withBsPrices) {
      cols.push('bs_prices');
      vals.push(
        bs
          ? JSON.stringify([
              { priceTypeId: PT_MAYOR, amount: p.mayor },
              { priceTypeId: PT_DETAL, amount: p.detal },
            ])
          : null,
      );
    }
    const params = cols.map((c, i) => (c === 'bs_prices' ? `$${i + 1}::jsonb` : `$${i + 1}`));
    const updates = cols.filter((c) => c !== 'id').map((c) => `${c} = EXCLUDED.${c}`);
    await db.query(
      `INSERT INTO products (${cols.join(', ')}) VALUES (${params.join(', ')})
       ON CONFLICT (id) DO UPDATE SET ${updates.join(', ')}, updated_at = now()`,
      vals,
    );
    await db.query(`DELETE FROM sync_deletions WHERE entity = 'product' AND entity_id = $1`, [p.id]);

    // Precios en USD sólo para los productos en USD: `product_prices` nunca
    // guarda bolívares.
    await db.query(`DELETE FROM product_prices WHERE product_id = $1`, [p.id]);
    if (!bs) {
      await db.query(
        `INSERT INTO product_prices (product_id, price_type_id, amount) VALUES ($1, $2, $3), ($1, $4, $5)`,
        [p.id, PT_MAYOR, p.mayor, PT_DETAL, p.detal],
      );
    }
  }
  log(`${catalog.products.length} productos cargados`);
}

async function main() {
  await db.connect();
  await db.query('BEGIN');
  await db.query(`SET LOCAL search_path TO "${schema}"`);
  await db.query(`SET LOCAL lock_timeout = '15s'`);
  log(`schema=${schema} · ${WIPE ? 'BORRADO + carga' : 'sólo carga'} · ${COMMIT ? 'COMMIT' : 'simulación (ROLLBACK)'}`);

  const pts = await db.query(`SELECT id FROM price_types WHERE id = ANY($1)`, [[PT_MAYOR, PT_DETAL]]);
  if (pts.rowCount !== 2) throw new Error('Faltan los tipos de precio pt-mayor / pt-detal');

  if (WIPE) await wipe();
  await load();

  for (const t of ['products', 'product_prices', 'sales', 'orders', 'order_deposits', 'inventory_movements', 'daily_closures', 'customers'])
    log(`  ${t.padEnd(22)} ${await count(t)}`);
  const byCur = await db.query(`SELECT bs_only, count(*)::int n FROM products GROUP BY 1 ORDER BY 1`);
  for (const r of byCur.rows) log(`  productos ${r.bs_only ? 'en Bs ' : 'en USD'}       ${r.n}`);

  await db.query(COMMIT ? 'COMMIT' : 'ROLLBACK');
  log(COMMIT ? 'HECHO (commit)' : 'simulación terminada: no se cambió nada');
}

main()
  .catch(async (e) => {
    console.error(`[reset] ERROR: ${e.message}`);
    await db.query('ROLLBACK').catch(() => {});
    process.exitCode = 1;
  })
  .finally(() => db.end());
