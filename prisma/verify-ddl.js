/**
 * Verificación de la capa de datos contra un Postgres REAL.
 *
 * Comprueba las invariantes que no viven en schema.prisma sino en el DDL escrito
 * a mano (triggers, CHECK, índices parciales): el cursor de sincronización, el
 * día contable, el ledger de inventario, las tablas append-only y las reglas de
 * precio. Ver ARCHITECTURE.md §7.
 *
 * ⚠ ES DESTRUCTIVO: borra y recrea el esquema `public` de la base a la que
 * apunte DATABASE_URL. Por eso sólo corre contra localhost, salvo que se ponga
 * ALLOW_DESTRUCTIVE_VERIFY=yes a propósito.
 *
 *   npx prisma dev            # levanta un Postgres local y muestra la URL
 *   DATABASE_URL=... npm run db:verify
 */
require("dotenv/config");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const URL = process.env.DATABASE_URL;
if (!URL) {
  console.error("Falta DATABASE_URL (ver .env.example o `npx prisma dev`).");
  process.exit(1);
}

// ── Guardia: nunca contra una base remota por accidente ─────────────────────
const { URL: NodeUrl } = require("node:url");
const host = (() => {
  try { return new NodeUrl(URL).hostname; } catch { return ""; }
})();
const isLocal = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);
if (!isLocal && process.env.ALLOW_DESTRUCTIVE_VERIFY !== "yes") {
  console.error(
    `Esta verificación BORRA el esquema public y DATABASE_URL apunta a "${host}".\n` +
      "Si de verdad es una base descartable, relanza con ALLOW_DESTRUCTIVE_VERIFY=yes.",
  );
  process.exit(1);
}

const MIGRATIONS_DIR = path.join(__dirname, "migrations");
// Todas las migraciones, en orden: el timestamp del nombre de carpeta ya las
// ordena lexicográficamente. Se aplican todas para que las migraciones
// posteriores a la inicial (ALTER sobre tablas que la inicial crea) también
// queden verificadas contra un Postgres real.
const MIGRATIONS = fs
  .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()
  .map((name) => path.join(MIGRATIONS_DIR, name, "migration.sql"));

let pass = 0;
const fails = [];
const ok = (name) => { pass++; console.log(`  ok   ${name}`); };
const bad = (name, detail) => { fails.push(`${name} :: ${detail}`); console.log(`  FAIL ${name} :: ${detail}`); };

async function expectError(c, sql, name, fragment) {
  try {
    await c.query("BEGIN");
    await c.query(sql);
    await c.query("ROLLBACK");
    bad(name, "se esperaba un error y no lo hubo");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    const msg = String(e.message);
    if (fragment && !msg.toLowerCase().includes(fragment.toLowerCase())) bad(name, `error distinto: ${msg}`);
    else ok(`${name} (rechazado: ${msg.split("\n")[0].slice(0, 70)})`);
  }
}

async function main() {
  const c = new Client({ connectionString: URL });
  await c.connect();
  await c.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");

  // ── 1 · Las migraciones aplican, en orden ──────────────────────────────────
  for (const migration of MIGRATIONS) {
    const label = path.basename(path.dirname(migration));
    try {
      await c.query(fs.readFileSync(migration, "utf8"));
      ok(`${label}/migration.sql aplica sin errores`);
    } catch (e) {
      bad(`${label}/migration.sql aplica`, e.message);
      await c.end();
      return report();
    }
  }

  const tables = await c.query(
    "SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'",
  );
  if (tables.rows[0].n === 29) ok("29 tablas creadas");
  else bad("número de tablas", `esperaba 29, hay ${tables.rows[0].n}`);

  const seeded = (await c.query(`
    SELECT (SELECT count(*)::int FROM users WHERE id='system') u,
           (SELECT count(*)::int FROM company_settings) cs,
           (SELECT count(*)::int FROM retired_product_codes) rc`)).rows[0];
  if (seeded.u === 1 && seeded.cs === 1 && seeded.rc === 13)
    ok("filas de infraestructura (usuario system, singleton, 13 códigos retirados)");
  else bad("filas de infraestructura", JSON.stringify(seeded));

  // El backfill de la migración de secuencia de códigos calcula el piso a
  // partir de lo que ya está en circulación: sólo hay sembrados los 13
  // códigos retirados P001..P013 en este punto (todavía no hay productos ni
  // líneas de venta/pedido), así que el piso tiene que quedar en 14.
  const codeSeq = (await c.query(
    `SELECT product_code_prefix p, product_code_digits d, product_code_start s FROM company_settings WHERE id='singleton'`,
  )).rows[0];
  if (codeSeq.p === "P" && codeSeq.d === 3 && codeSeq.s === 14)
    ok(`el backfill deja el piso en el primer número libre tras los retirados sembrados (${codeSeq.p}/${codeSeq.d}/${codeSeq.s})`);
  else bad("backfill de product_code_start", JSON.stringify(codeSeq));

  // ── 2 · Fixture mínimo ─────────────────────────────────────────────────────
  await c.query(`
    INSERT INTO roles (id,name,updated_at) VALUES ('role-admin','Administrador',now());
    INSERT INTO role_permissions (role_id,permission) VALUES ('role-admin','create_sale'),('role-admin','close_cash');
    INSERT INTO users (id,username,full_name,password_hash,role_id,updated_at)
      VALUES ('user-admin','admin','Administrador','$argon2id$fake','role-admin',now());
    INSERT INTO categories (id,name,updated_at) VALUES ('cat-tortas-frias','Tortas Frias',now());
    INSERT INTO price_types (id,name,is_default,updated_at) VALUES ('pt-mayor','Mayor',true,now()),('pt-detal','Detal',false,now());
    INSERT INTO price_groups (id,name,category_id,rule_min_usd,rule_target_usd,rule_band_min_usd,rule_band_max_usd,updated_at)
      VALUES ('pg-tortas-frias','Tortas Frias','cat-tortas-frias',1.10,1.30,1.10,1.30,now());
    INSERT INTO price_group_prices (price_group_id,price_type_id,amount,updated_at)
      VALUES ('pg-tortas-frias','pt-mayor',1.10,now()),('pg-tortas-frias','pt-detal',1.11,now());
    INSERT INTO products (id,code,name,category_id,price_group_id,stock,updated_at)
      VALUES ('prod-P060','P060','Tortas Frias','cat-tortas-frias','pg-tortas-frias',20,now());
    INSERT INTO product_prices (product_id,price_type_id,amount,updated_at)
      VALUES ('prod-P060','pt-mayor',1.10,now());
    INSERT INTO customers (id,cedula,name,updated_at) VALUES ('cus-1','V-12345678','Maria Rodriguez',now());
    INSERT INTO payment_methods (id,name,currency,requires_reference,updated_at)
      VALUES ('pm-bs','Bs efectivo','BS',false,now()),('pm-usd','USD efectivo','USD',false,now());
    UPDATE company_settings SET cold_cake_category_id='cat-tortas-frias' WHERE id='singleton';
  `);
  ok("fixture mínimo insertado");

  // ── 3 · Cursor de sincronización ───────────────────────────────────────────
  const r = (await c.query(`
    SELECT (SELECT rev FROM products WHERE id='prod-P060') p,
           (SELECT rev FROM customers WHERE id='cus-1') cu,
           (SELECT rev FROM categories WHERE id='cat-tortas-frias') ca`)).rows[0];
  if (new Set([r.p, r.cu, r.ca]).size === 3) ok(`rev global sin colisiones entre tablas (${r.ca},${r.p},${r.cu})`);
  else bad("rev global", JSON.stringify(r));

  const before = (await c.query("SELECT rev, updated_at FROM products WHERE id='prod-P060'")).rows[0];
  await c.query("UPDATE products SET name='Tortas Frias' WHERE id='prod-P060'");
  const noop = (await c.query("SELECT rev, updated_at FROM products WHERE id='prod-P060'")).rows[0];
  if (noop.rev === before.rev && +noop.updated_at === +before.updated_at) ok("un UPDATE no-op NO mueve el cursor");
  else bad("UPDATE no-op", `rev ${before.rev}->${noop.rev}`);

  await c.query("UPDATE products SET min_stock=7 WHERE id='prod-P060'");
  const changed = (await c.query("SELECT rev, updated_at FROM products WHERE id='prod-P060'")).rows[0];
  if (changed.rev > before.rev && +changed.updated_at > +before.updated_at)
    ok(`un UPDATE real bumpea rev (${before.rev}->${changed.rev}) y updated_at`);
  else bad("UPDATE real", `rev ${before.rev}->${changed.rev}`);

  // Cambios en filas hijas tienen que reenviar el agregado.
  for (const [child, sql, parentTable, parentId] of [
    ["product_prices", "UPDATE product_prices SET amount=1.15 WHERE product_id='prod-P060' AND price_type_id='pt-mayor'", "products", "prod-P060"],
    ["price_group_prices", "UPDATE price_group_prices SET amount=1.20 WHERE price_group_id='pg-tortas-frias' AND price_type_id='pt-mayor'", "price_groups", "pg-tortas-frias"],
    ["role_permissions", "DELETE FROM role_permissions WHERE role_id='role-admin' AND permission='close_cash'", "roles", "role-admin"],
  ]) {
    const a = (await c.query(`SELECT rev FROM ${parentTable} WHERE id=$1`, [parentId])).rows[0].rev;
    await c.query(sql);
    const b = (await c.query(`SELECT rev FROM ${parentTable} WHERE id=$1`, [parentId])).rows[0].rev;
    if (b > a) ok(`${child} bumpea ${parentTable}.rev (${a}->${b})`);
    else bad(`bump del padre desde ${child}`, `rev ${a}->${b}`);
  }

  // ── 4 · Día contable en la zona del negocio ────────────────────────────────
  // 01:30Z del 13/09 son las 21:30 del 12/09 en Caracas: la caja del 12.
  await c.query(`
    INSERT INTO sales (id,number,created_at,customer_id,customer_name,user_id,user_name,
                       total_usd,total_bs,rate_usd,rate_eur,rate_binance,rate_at,updated_at)
    VALUES ('sale-late','V-00001','2026-09-13T01:30:00Z','cus-1','Maria Rodriguez','user-admin','Administrador',
            2.20,1792.32,814.6908,947.29802151,836.5,'2026-09-13T01:00:00Z',now())`);
  const bd = (await c.query("SELECT business_date::text d FROM sales WHERE id='sale-late'")).rows[0].d;
  if (bd === "2026-09-12") ok(`business_date usa la zona del negocio (01:30Z -> ${bd})`);
  else bad("business_date", `esperaba 2026-09-12, obtuve ${bd}`);

  await c.query("UPDATE sales SET business_date='2000-01-01' WHERE id='sale-late'");
  const bd2 = (await c.query("SELECT business_date::text d FROM sales WHERE id='sale-late'")).rows[0].d;
  if (bd2 === "2026-09-12") ok("business_date no se puede falsear desde el cliente");
  else bad("business_date falseable", `quedó en ${bd2}`);

  await c.query("UPDATE company_settings SET timezone='UTC' WHERE id='singleton'");
  await c.query("UPDATE sales SET created_at='2026-09-13T01:30:00Z' WHERE id='sale-late'");
  const bd3 = (await c.query("SELECT business_date::text d FROM sales WHERE id='sale-late'")).rows[0].d;
  await c.query("UPDATE company_settings SET timezone='America/Caracas' WHERE id='singleton'");
  if (bd3 === "2026-09-13") ok("business_date respeta company_settings.timezone");
  else bad("business_date/timezone", `con UTC esperaba 2026-09-13, obtuve ${bd3}`);

  // ── 5 · Ledger de inventario ───────────────────────────────────────────────
  await c.query(`
    INSERT INTO inventory_movements (id,product_id,type,qty,delta,stock_after,reason,user_id)
    VALUES ('mov-1','prod-P060','salida',2,-2,18,'Salida por venta','user-admin')`);
  ok("movimiento de salida asentado (delta = -qty)");

  await expectError(c,
    `INSERT INTO inventory_movements (id,product_id,type,qty,delta,stock_after,reason,user_id)
     VALUES ('mov-bad','prod-P060','salida',2,2,22,'Delta mentiroso','user-admin')`,
    "un movimiento cuyo delta contradice su tipo se rechaza", "inventory_movements_delta_ck");
  await expectError(c,
    `INSERT INTO inventory_movements (id,product_id,type,qty,delta,stock_after,reason,user_id)
     VALUES ('mov-bad2','prod-P060','ajuste',10,3,99,'Ajuste incoherente','user-admin')`,
    "un ajuste cuyo stock_after no es la cantidad se rechaza", "inventory_movements_delta_ck");
  await expectError(c, "UPDATE inventory_movements SET qty=99 WHERE id='mov-1'",
    "kardex append-only: UPDATE prohibido", "append-only");
  await expectError(c, "DELETE FROM inventory_movements WHERE id='mov-1'",
    "kardex append-only: DELETE prohibido", "append-only");

  await c.query(`INSERT INTO audit_log (id,user_id,user_name,action,entity,entity_id,data)
                 VALUES ('aud-1','user-admin','Administrador','venta_creada','sale','sale-late','{"number":"V-00001"}')`);
  await expectError(c, "UPDATE audit_log SET action='x' WHERE id='aud-1'",
    "audit_log append-only: UPDATE prohibido", "append-only");
  await expectError(c, "DELETE FROM audit_log WHERE id='aud-1'",
    "audit_log append-only: DELETE prohibido", "append-only");
  const auditData = (await c.query("SELECT data->>'number' n FROM audit_log WHERE id='aud-1'")).rows[0].n;
  if (auditData === "V-00001") ok("audit_log.data es jsonb consultable");
  else bad("audit_log.data", auditData);

  // ── 6 · Pedidos, abonos y doble facturación ────────────────────────────────
  await c.query(`
    INSERT INTO orders (id,number,created_at,customer_id,customer_name,user_id,total_usd,status,updated_at)
      VALUES ('ord-1','P-00001',now(),'cus-1','Maria Rodriguez','user-admin',5.00,'pendiente',now());
    INSERT INTO order_items (id,order_id,position,product_id,code,name,qty,price_type_id,unit_price_usd,subtotal_usd)
      VALUES ('oi-1','ord-1',0,'prod-P060','P060','Tortas Frias',4,'pt-mayor',1.25,5.00);
    INSERT INTO order_deposits (id,order_id,method_id,method_name,currency,amount,usd_equivalent,rate_used,at,user_id,updated_at)
      VALUES ('dep-1','ord-1','pm-bs','Bs efectivo','BS',1629.38,2.00,814.6908,'2026-09-10T14:00:00Z','user-admin',now());
  `);
  ok("pedido con abono creado");

  const oBefore = (await c.query("SELECT rev FROM orders WHERE id='ord-1'")).rows[0].rev;
  await c.query("UPDATE order_items SET qty=5, subtotal_usd=6.25 WHERE id='oi-1'");
  const oAfter = (await c.query("SELECT rev FROM orders WHERE id='ord-1'")).rows[0].rev;
  if (oAfter > oBefore) ok(`order_items bumpea orders.rev (${oBefore}->${oAfter})`);
  else bad("bump del padre desde order_items", `rev ${oBefore}->${oAfter}`);

  // Un abono nuevo NO debe invalidar el bloqueo optimista del pedido: el saldo
  // es derivado, y si lo moviera daría un 409 espurio a quien edita las líneas.
  const dBefore = (await c.query("SELECT rev FROM orders WHERE id='ord-1'")).rows[0].rev;
  await c.query(`INSERT INTO order_deposits (id,order_id,method_id,method_name,currency,amount,usd_equivalent,rate_used,at,user_id,updated_at)
                 VALUES ('dep-2','ord-1','pm-usd','USD efectivo','USD',1.00,1.00,814.6908,now(),'user-admin',now())`);
  const dAfter = (await c.query("SELECT rev FROM orders WHERE id='ord-1'")).rows[0].rev;
  if (dAfter === dBefore) ok("un abono nuevo no invalida el bloqueo optimista del pedido");
  else bad("el abono mueve orders.rev", `rev ${dBefore}->${dAfter}`);

  const depDate = (await c.query("SELECT business_date::text d FROM order_deposits WHERE id='dep-1'")).rows[0].d;
  if (depDate === "2026-09-10") ok("el abono conserva su propio día contable (10/09), no el de la venta");
  else bad("business_date del abono", depDate);

  await c.query(`
    INSERT INTO sales (id,number,created_at,customer_id,customer_name,user_id,user_name,total_usd,total_bs,
                       rate_usd,rate_eur,rate_binance,rate_at,order_id,updated_at)
      VALUES ('sale-ord','V-00002',now(),'cus-1','Maria Rodriguez','user-admin','Administrador',5.00,4073.45,
              814.6908,947.29802151,836.5,now(),'ord-1',now());
    UPDATE orders SET status='procesado', sale_id='sale-ord' WHERE id='ord-1';
  `);
  ok("pedido facturado");

  await expectError(c,
    `INSERT INTO sales (id,number,created_at,customer_id,customer_name,user_id,user_name,total_usd,total_bs,
                        rate_usd,rate_eur,rate_binance,rate_at,order_id,updated_at)
     VALUES ('sale-dup','V-00003',now(),'cus-1','Maria','user-admin','Administrador',5.00,4073.45,
             814.6908,947.29802151,836.5,now(),'ord-1',now())`,
    "no se puede facturar dos veces el mismo pedido", "sales_active_order_uq");

  await c.query("BEGIN");
  await c.query("UPDATE sales SET status='anulada', voided_at=now(), void_reason='prueba' WHERE id='sale-ord'");
  try {
    await c.query(`
      INSERT INTO sales (id,number,created_at,customer_id,customer_name,user_id,user_name,total_usd,total_bs,
                         rate_usd,rate_eur,rate_binance,rate_at,order_id,updated_at)
      VALUES ('sale-re','V-00004',now(),'cus-1','Maria','user-admin','Administrador',5.00,4073.45,
              814.6908,947.29802151,836.5,now(),'ord-1',now())`);
    ok("una venta anulada libera el pedido para refacturarlo");
  } catch (e) { bad("refacturar tras anular", e.message); }
  await c.query("ROLLBACK");

  await expectError(c, "UPDATE sales SET status='anulada' WHERE id='sale-ord'",
    "una anulación sin fecha se rechaza", "sales_voided_needs_date_ck");

  await c.query(`
    INSERT INTO sale_payments (id,sale_id,position,method_id,method_name,currency,amount,usd_equivalent,at,rate_used,from_order_deposit_id)
    VALUES ('pay-1','sale-ord',0,'pm-bs','Bs efectivo','BS',1629.38,2.00,'2026-09-10T14:00:00Z',814.6908,'dep-1')`);
  await expectError(c,
    `INSERT INTO sale_payments (id,sale_id,position,method_id,method_name,currency,amount,usd_equivalent,at,rate_used,from_order_deposit_id)
     VALUES ('pay-2','sale-ord',1,'pm-bs','Bs efectivo','BS',1629.38,2.00,now(),814.6908,'dep-1')`,
    "un abono no puede consumirse en dos pagos", "from_order_deposit");
  await expectError(c,
    `INSERT INTO sale_payments (id,sale_id,position,method_id,method_name,currency,amount,usd_equivalent,at)
     VALUES ('pay-3','sale-ord',2,'pm-bs','Bs efectivo','BS',100,0.12,now())`,
    "un cobro en Bs exige la tasa congelada", "bs_needs_rate");

  // ── 7 · Resto de invariantes ───────────────────────────────────────────────
  await expectError(c, "INSERT INTO company_settings (id,name,updated_at) VALUES ('otra','X',now())",
    "company_settings es fila única", "singleton");
  await expectError(c, "UPDATE company_settings SET product_code_prefix='p1' WHERE id='singleton'",
    "el prefijo de código de producto no puede ser minúscula ni terminar en dígito", "product_code_prefix_ck");
  await expectError(c, "UPDATE company_settings SET product_code_prefix='1P' WHERE id='singleton'",
    "el prefijo de código de producto tiene que empezar con letra", "product_code_prefix_ck");
  await expectError(c, "UPDATE company_settings SET product_code_digits=0 WHERE id='singleton'",
    "los dígitos del código de producto están acotados (mínimo 1)", "product_code_digits_ck");
  await expectError(c, "UPDATE company_settings SET product_code_digits=7 WHERE id='singleton'",
    "los dígitos del código de producto están acotados (máximo 6)", "product_code_digits_ck");
  await expectError(c, "UPDATE company_settings SET product_code_start=0 WHERE id='singleton'",
    "el piso del código de producto no puede ser menor a 1", "product_code_start_ck");
  await expectError(c, "UPDATE company_settings SET product_code_start=100000000 WHERE id='singleton'",
    "el piso del código de producto está acotado (máximo 99999999)", "product_code_start_ck");
  await c.query("UPDATE company_settings SET product_code_prefix='PX', product_code_digits=4, product_code_start=50 WHERE id='singleton'");
  const codeSeqOk = (await c.query(
    `SELECT product_code_prefix p, product_code_digits d, product_code_start s FROM company_settings WHERE id='singleton'`,
  )).rows[0];
  if (codeSeqOk.p === "PX" && codeSeqOk.d === 4 && codeSeqOk.s === 50)
    ok("un prefijo/dígitos/piso válidos se guardan");
  else bad("guardar prefijo/dígitos/piso válidos", JSON.stringify(codeSeqOk));
  await expectError(c, "INSERT INTO customers (id,cedula,name,updated_at) VALUES ('c2','v-999','x',now())",
    "una cédula sin normalizar se rechaza", "cedula_upper");
  await expectError(c, "INSERT INTO price_groups (id,name,rule_min_usd,updated_at) VALUES ('pg-x','X',1.10,now())",
    "regla de precio incompleta (umbral sin objetivo)", "rule_pair");
  await expectError(c, "INSERT INTO price_groups (id,name,rule_band_min_usd,rule_band_max_usd,updated_at) VALUES ('pg-y','Y',1.0,1.2,now())",
    "banda sin regla", "band_needs_rule");
  await expectError(c, "INSERT INTO price_groups (id,name,rule_min_usd,rule_target_usd,updated_at) VALUES ('pg-z','Z',1.30,1.20,now())",
    "objetivo por debajo del umbral", "target_ge_min");
  await expectError(c, "UPDATE price_types SET is_default=true WHERE id='pt-detal'",
    "sólo un tipo de precio por defecto", "price_types_single_default_uq");
  await expectError(c, "INSERT INTO products (id,code,name,category_id,bs_only,updated_at) VALUES ('p-x','X9','X','cat-tortas-frias',true,now())",
    "un producto bs_only sin precio en Bs se rechaza", "bs_only_needs_price");
  await expectError(c, "INSERT INTO users (id,username,full_name,password_hash,role_id,active,system,updated_at) VALUES ('u2','u2','U','h','role-admin',true,true,now())",
    "un usuario de sistema no puede estar activo", "system_not_active");
  await expectError(c,
    `INSERT INTO daily_closures (id,date,user_id,user_name,sales_count,total_usd,total_bs,expected_usd,received_usd,difference_usd,closed_at,updated_at)
     VALUES ('cl-1','2026-09-12','user-admin','Administrador',1,2.20,1792.32,2.20,2.00,0.50,now(),now())`,
    "la diferencia del cierre tiene que cuadrar", "difference");
  await expectError(c, "UPDATE products SET code='P001' WHERE id='prod-P060'",
    "un código retirado (P001) no se puede reutilizar", "retirado");
  await expectError(c, "INSERT INTO products (id,code,name,category_id,updated_at) VALUES ('p-dup','P060','Otro','cat-tortas-frias',now())",
    "código de producto único entre productos vivos", "products_code_key");
  await expectError(c, "DELETE FROM products WHERE id='prod-P060'",
    "un producto con historial no se puede borrar", "foreign key");

  const inv = (await c.query(`
    SELECT p.stock::text stock, COALESCE(SUM(m.delta),0)::text deltas
      FROM products p LEFT JOIN inventory_movements m ON m.product_id=p.id
     WHERE p.id='prod-P060' GROUP BY p.stock`)).rows[0];
  ok(`consulta de reconciliación stock/ledger operativa (stock ${inv.stock}, suma deltas ${inv.deltas})`);

  await c.query("INSERT INTO sync_deletions (entity,entity_id,deleted_by_user_id) VALUES ('customer','cus-borrado','user-admin')");
  const maxRev = (await c.query(`
    SELECT GREATEST((SELECT COALESCE(MAX(rev),0) FROM sync_deletions),
                    (SELECT COALESCE(MAX(rev),0) FROM products)) m`)).rows[0].m;
  const tomb = (await c.query("SELECT rev FROM sync_deletions")).rows[0].rev;
  if (tomb === maxRev) ok(`el tombstone toma el rev más alto del cursor global (${tomb})`);
  else bad("tombstone en el cursor", `tombstone ${tomb} vs max ${maxRev}`);

  await c.end();
  report();
}

function report() {
  console.log(`\n=== ${pass} comprobaciones ok · ${fails.length} fallos ===`);
  if (fails.length) { fails.forEach((f) => console.log("FAIL " + f)); process.exitCode = 1; }
}

main().catch((e) => { console.error("ERROR FATAL", e); process.exitCode = 1; });
