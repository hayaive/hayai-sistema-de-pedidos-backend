-- ═════════════════════════════════════════════════════════════════════════════
-- Migración inicial · POS Karelys Delicias
--
-- Estructura del archivo:
--   1. Secuencia global `sync_rev_seq`  (A MANO — va primero porque el bloque 3
--      crea los triggers que la usan)
--   2. Cuerpo generado por `prisma migrate diff` (tipos, tablas, índices, FKs)
--   3. Bloque A MANO: funciones, triggers, CHECK, índices parciales y filas de
--      infraestructura que el DSL de Prisma no puede expresar
--
-- ⚠ LEE ESTO ANTES DE REGENERAR MIGRACIONES ⚠
-- Prisma no representa secuencias sueltas, funciones, triggers, CHECK ni el
-- predicado de un índice parcial: no los ve en el diff y no los va a borrar.
-- Verificado en este esquema con
--
--   npx prisma migrate diff --from-migrations prisma/migrations \
--       --to-schema prisma/schema.prisma --script
--
-- ...que sale VACÍO con todo el bloque 3 aplicado. Ese es además el comando con
-- el que se escriben las migraciones siguientes: se genera el script, se REVISA
-- (que no traiga ningún DROP contra los objetos de aquí) y se commitea. Usar
-- `prisma migrate dev` a ciegas es lo único peligroso.
-- Ver ARCHITECTURE.md §"DDL escrito a mano".
-- ═════════════════════════════════════════════════════════════════════════════

CREATE SCHEMA IF NOT EXISTS "public";

-- ─── 1 · Secuencia del cursor de sincronización ───────────────────────────────
-- Una sola secuencia para TODAS las tablas sincronizables: así `rev` es un orden
-- total global, el cliente puede ordenar el delta completo por rev y aplicarlo
-- en ese orden, y un mismo número no aparece nunca en dos tablas. La asigna el
-- trigger `sync_assign_rev` (bloque 3.1), no un DEFAULT de columna.
--
-- Es `AS integer` a propósito: 2.147.483.647 escrituras alcanzan para siglos en
-- este negocio, y un INTEGER viaja como número JSON normal (un BIGINT de Prisma
-- rompe JSON.stringify y obliga a serializadores a medida).
-- Vigilar: si `last_value` pasa de 2.000.000.000 hay que migrar la columna a
-- BIGINT antes de que la secuencia se agote.
CREATE SEQUENCE IF NOT EXISTS "sync_rev_seq" AS integer START 1;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2 - Cuerpo generado por `prisma migrate diff` (no editar a mano)
-- ═════════════════════════════════════════════════════════════════════════════

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "permission" AS ENUM ('view_sales', 'create_sale', 'edit_sale', 'cancel_sale', 'view_inventory', 'edit_inventory', 'view_customers', 'edit_customers', 'view_orders', 'edit_orders', 'process_orders', 'close_cash', 'manage_users', 'manage_settings', 'manage_exchange_rates');

-- CreateEnum
CREATE TYPE "movement_type" AS ENUM ('entrada', 'salida', 'ajuste');

-- CreateEnum
CREATE TYPE "sale_status" AS ENUM ('completada', 'anulada');

-- CreateEnum
CREATE TYPE "order_status" AS ENUM ('pendiente', 'preparacion', 'listo', 'procesado', 'cancelado');

-- CreateEnum
CREATE TYPE "currency" AS ENUM ('USD', 'BS');

-- CreateEnum
CREATE TYPE "rate_source" AS ENUM ('BCV_USD', 'BCV_EUR', 'BINANCE');

-- CreateEnum
CREATE TYPE "rate_currency" AS ENUM ('USD', 'EUR');

-- CreateEnum
CREATE TYPE "sync_entity" AS ENUM ('category', 'price_type', 'price_group', 'product', 'customer', 'user', 'role', 'payment_method', 'order');

-- CreateEnum
CREATE TYPE "mutation_status" AS ENUM ('applied', 'duplicate', 'conflict', 'rejected');

-- CreateTable
CREATE TABLE "roles" (
    "id" VARCHAR(64) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rev" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" VARCHAR(64) NOT NULL,
    "permission" "permission" NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission")
);

-- CreateTable
CREATE TABLE "users" (
    "id" VARCHAR(64) NOT NULL,
    "username" VARCHAR(40) NOT NULL,
    "full_name" VARCHAR(120) NOT NULL,
    "email" VARCHAR(160),
    "password_hash" VARCHAR(255) NOT NULL,
    "password_updated_at" TIMESTAMPTZ(3),
    "role_id" VARCHAR(64) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "deactivated_at" TIMESTAMPTZ(3),
    "system" BOOLEAN NOT NULL DEFAULT false,
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rev" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" VARCHAR(64) NOT NULL,
    "user_id" VARCHAR(64) NOT NULL,
    "token_hash" VARCHAR(255) NOT NULL,
    "device_id" VARCHAR(64),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "last_used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" VARCHAR(64) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rev" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_types" (
    "id" VARCHAR(64) NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rev" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "price_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_groups" (
    "id" VARCHAR(64) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "category_id" VARCHAR(64),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "rule_min_usd" DECIMAL(14,4),
    "rule_target_usd" DECIMAL(14,4),
    "rule_band_min_usd" DECIMAL(14,4),
    "rule_band_max_usd" DECIMAL(14,4),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rev" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "price_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_group_prices" (
    "price_group_id" VARCHAR(64) NOT NULL,
    "price_type_id" VARCHAR(64) NOT NULL,
    "amount" DECIMAL(14,4) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_group_prices_pkey" PRIMARY KEY ("price_group_id","price_type_id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" VARCHAR(64) NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "description" TEXT,
    "category_id" VARCHAR(64) NOT NULL,
    "image_url" TEXT,
    "stock" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "min_stock" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "bs_only" BOOLEAN NOT NULL DEFAULT false,
    "bs_price" DECIMAL(18,4),
    "price_group_id" VARCHAR(64),
    "is_combo" BOOLEAN NOT NULL DEFAULT false,
    "allow_customization" BOOLEAN NOT NULL DEFAULT false,
    "customization_price" DECIMAL(14,4),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rev" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_prices" (
    "product_id" VARCHAR(64) NOT NULL,
    "price_type_id" VARCHAR(64) NOT NULL,
    "amount" DECIMAL(14,4) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_prices_pkey" PRIMARY KEY ("product_id","price_type_id")
);

-- CreateTable
CREATE TABLE "combo_items" (
    "id" VARCHAR(64) NOT NULL,
    "combo_product_id" VARCHAR(64) NOT NULL,
    "position" INTEGER NOT NULL,
    "description" VARCHAR(160) NOT NULL,
    "qty" DECIMAL(14,3) NOT NULL,
    "component_product_id" VARCHAR(64),

    CONSTRAINT "combo_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retired_product_codes" (
    "code" VARCHAR(32) NOT NULL,
    "former_name" VARCHAR(160),
    "former_product_id" VARCHAR(64),
    "reason" VARCHAR(200),
    "retired_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retired_product_codes_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "inventory_movements" (
    "id" VARCHAR(64) NOT NULL,
    "product_id" VARCHAR(64) NOT NULL,
    "type" "movement_type" NOT NULL,
    "qty" DECIMAL(14,3) NOT NULL,
    "delta" DECIMAL(14,3) NOT NULL,
    "stock_after" DECIMAL(14,3) NOT NULL,
    "reason" VARCHAR(120) NOT NULL,
    "note" TEXT,
    "user_id" VARCHAR(64) NOT NULL,
    "sale_id" VARCHAR(64),
    "order_id" VARCHAR(64),
    "device_id" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rev" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" VARCHAR(64) NOT NULL,
    "cedula" VARCHAR(24) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "phone" VARCHAR(40),
    "address" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rev" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_rates" (
    "id" VARCHAR(64) NOT NULL,
    "source" "rate_source" NOT NULL,
    "currency" "rate_currency" NOT NULL,
    "value" DECIMAL(18,8) NOT NULL,
    "automatic" BOOLEAN NOT NULL DEFAULT false,
    "user_id" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rev" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_methods" (
    "id" VARCHAR(64) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "currency" "currency" NOT NULL,
    "requires_reference" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rev" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales" (
    "id" VARCHAR(64) NOT NULL,
    "number" VARCHAR(24) NOT NULL,
    "client_number" VARCHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "business_date" DATE NOT NULL DEFAULT CURRENT_DATE,
    "customer_id" VARCHAR(64),
    "customer_name" VARCHAR(160) NOT NULL DEFAULT 'Consumidor final',
    "user_id" VARCHAR(64) NOT NULL,
    "user_name" VARCHAR(120) NOT NULL,
    "total_usd" DECIMAL(14,4) NOT NULL,
    "total_bs" DECIMAL(18,4) NOT NULL,
    "change_usd" DECIMAL(14,4),
    "rate_usd" DECIMAL(18,8) NOT NULL,
    "rate_eur" DECIMAL(18,8) NOT NULL,
    "rate_binance" DECIMAL(18,8) NOT NULL,
    "rate_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "sale_status" NOT NULL DEFAULT 'completada',
    "order_id" VARCHAR(64),
    "note" TEXT,
    "voided_at" TIMESTAMPTZ(3),
    "void_reason" VARCHAR(300),
    "voided_by_user_id" VARCHAR(64),
    "device_id" VARCHAR(64),
    "created_offline" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rev" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_items" (
    "id" VARCHAR(64) NOT NULL,
    "sale_id" VARCHAR(64) NOT NULL,
    "position" INTEGER NOT NULL,
    "product_id" VARCHAR(64) NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "qty" DECIMAL(14,3) NOT NULL,
    "price_type_id" VARCHAR(64) NOT NULL,
    "unit_price_usd" DECIMAL(14,4) NOT NULL,
    "unit_price_bs" DECIMAL(18,4),
    "bs_only" BOOLEAN NOT NULL DEFAULT false,
    "customization" VARCHAR(300),
    "customization_price" DECIMAL(14,4),
    "subtotal_usd" DECIMAL(14,4) NOT NULL,

    CONSTRAINT "sale_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_payments" (
    "id" VARCHAR(64) NOT NULL,
    "sale_id" VARCHAR(64) NOT NULL,
    "position" INTEGER NOT NULL,
    "method_id" VARCHAR(64) NOT NULL,
    "method_name" VARCHAR(80) NOT NULL,
    "currency" "currency" NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "usd_equivalent" DECIMAL(14,4) NOT NULL,
    "reference" VARCHAR(80),
    "at" TIMESTAMPTZ(3) NOT NULL,
    "business_date" DATE NOT NULL DEFAULT CURRENT_DATE,
    "rate_used" DECIMAL(18,8),
    "from_order_deposit_id" VARCHAR(64),

    CONSTRAINT "sale_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" VARCHAR(64) NOT NULL,
    "number" VARCHAR(24) NOT NULL,
    "client_number" VARCHAR(24),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "business_date" DATE NOT NULL DEFAULT CURRENT_DATE,
    "customer_id" VARCHAR(64),
    "customer_name" VARCHAR(160) NOT NULL DEFAULT 'Consumidor final',
    "user_id" VARCHAR(64) NOT NULL,
    "total_usd" DECIMAL(14,4) NOT NULL,
    "note" TEXT,
    "status" "order_status" NOT NULL DEFAULT 'pendiente',
    "sale_id" VARCHAR(64),
    "canceled_at" TIMESTAMPTZ(3),
    "cancel_reason" VARCHAR(300),
    "device_id" VARCHAR(64),
    "created_offline" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rev" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" VARCHAR(64) NOT NULL,
    "order_id" VARCHAR(64) NOT NULL,
    "position" INTEGER NOT NULL,
    "product_id" VARCHAR(64) NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "qty" DECIMAL(14,3) NOT NULL,
    "price_type_id" VARCHAR(64) NOT NULL,
    "unit_price_usd" DECIMAL(14,4) NOT NULL,
    "unit_price_bs" DECIMAL(18,4),
    "bs_only" BOOLEAN NOT NULL DEFAULT false,
    "customization" VARCHAR(300),
    "customization_price" DECIMAL(14,4),
    "subtotal_usd" DECIMAL(14,4) NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_deposits" (
    "id" VARCHAR(64) NOT NULL,
    "order_id" VARCHAR(64) NOT NULL,
    "method_id" VARCHAR(64) NOT NULL,
    "method_name" VARCHAR(80) NOT NULL,
    "currency" "currency" NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "usd_equivalent" DECIMAL(14,4) NOT NULL,
    "rate_used" DECIMAL(18,8) NOT NULL,
    "reference" VARCHAR(80),
    "note" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "business_date" DATE NOT NULL DEFAULT CURRENT_DATE,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" VARCHAR(64) NOT NULL,
    "sale_id" VARCHAR(64),
    "voided" BOOLEAN NOT NULL DEFAULT false,
    "voided_at" TIMESTAMPTZ(3),
    "void_reason" VARCHAR(300),
    "voided_by_user_id" VARCHAR(64),
    "device_id" VARCHAR(64),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rev" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "order_deposits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_closures" (
    "id" VARCHAR(64) NOT NULL,
    "date" DATE NOT NULL,
    "user_id" VARCHAR(64) NOT NULL,
    "user_name" VARCHAR(120) NOT NULL,
    "sales_count" INTEGER NOT NULL,
    "total_usd" DECIMAL(14,4) NOT NULL,
    "total_bs" DECIMAL(18,4) NOT NULL,
    "deposit_usd" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "expected_usd" DECIMAL(14,4) NOT NULL,
    "received_usd" DECIMAL(14,4) NOT NULL,
    "difference_usd" DECIMAL(14,4) NOT NULL,
    "note" TEXT,
    "closed_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rev" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "daily_closures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "closure_methods" (
    "closure_id" VARCHAR(64) NOT NULL,
    "method_id" VARCHAR(64) NOT NULL,
    "method_name" VARCHAR(80) NOT NULL,
    "expected" DECIMAL(14,4) NOT NULL,
    "received" DECIMAL(14,4) NOT NULL,

    CONSTRAINT "closure_methods_pkey" PRIMARY KEY ("closure_id","method_id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" VARCHAR(64) NOT NULL,
    "user_id" VARCHAR(64) NOT NULL,
    "user_name" VARCHAR(120) NOT NULL,
    "action" VARCHAR(60) NOT NULL,
    "entity" VARCHAR(40) NOT NULL,
    "entity_id" VARCHAR(64) NOT NULL,
    "data" JSONB,
    "device_id" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rev" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_settings" (
    "id" VARCHAR(16) NOT NULL DEFAULT 'singleton',
    "name" VARCHAR(160) NOT NULL,
    "logo_url" TEXT NOT NULL DEFAULT '',
    "phone" VARCHAR(60) NOT NULL DEFAULT '',
    "address" TEXT NOT NULL DEFAULT '',
    "tax_id" VARCHAR(40) NOT NULL DEFAULT '',
    "ticket_footer" TEXT NOT NULL DEFAULT '',
    "sale_prefix" VARCHAR(8) NOT NULL DEFAULT 'V-',
    "sale_next" INTEGER NOT NULL DEFAULT 1,
    "order_prefix" VARCHAR(8) NOT NULL DEFAULT 'P-',
    "order_next" INTEGER NOT NULL DEFAULT 1,
    "cold_cake_min" DECIMAL(14,4) NOT NULL DEFAULT 1.10,
    "cold_cake_max" DECIMAL(14,4) NOT NULL DEFAULT 1.30,
    "cold_cake_category_id" VARCHAR(64),
    "bs_rounding" DECIMAL(10,4) NOT NULL DEFAULT 1,
    "rate_max_age_hours" INTEGER NOT NULL DEFAULT 24,
    "timezone" VARCHAR(60) NOT NULL DEFAULT 'America/Caracas',
    "schema_version" INTEGER NOT NULL DEFAULT 3,
    "shortcuts" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rev" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "company_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" VARCHAR(64) NOT NULL,
    "name" VARCHAR(120),
    "user_agent" TEXT,
    "last_user_id" VARCHAR(64),
    "last_seen_at" TIMESTAMPTZ(3),
    "last_cursor" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_mutations" (
    "id" VARCHAR(64) NOT NULL,
    "device_id" VARCHAR(64),
    "user_id" VARCHAR(64),
    "entity" VARCHAR(40) NOT NULL,
    "op" VARCHAR(40) NOT NULL,
    "entity_id" VARCHAR(64) NOT NULL,
    "status" "mutation_status" NOT NULL,
    "reject_reason" VARCHAR(200),
    "result" JSONB,
    "client_at" TIMESTAMPTZ(3),
    "applied_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_mutations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_deletions" (
    "id" SERIAL NOT NULL,
    "entity" "sync_entity" NOT NULL,
    "entity_id" VARCHAR(64) NOT NULL,
    "deleted_by_user_id" VARCHAR(64),
    "deleted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rev" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "sync_deletions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- CreateIndex
CREATE INDEX "roles_rev_idx" ON "roles"("rev");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "users_rev_idx" ON "users"("rev");

-- CreateIndex
CREATE INDEX "users_role_id_idx" ON "users"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "categories_name_key" ON "categories"("name");

-- CreateIndex
CREATE INDEX "categories_rev_idx" ON "categories"("rev");

-- CreateIndex
CREATE UNIQUE INDEX "price_types_name_key" ON "price_types"("name");

-- CreateIndex
CREATE INDEX "price_types_rev_idx" ON "price_types"("rev");

-- CreateIndex
CREATE INDEX "price_groups_category_id_idx" ON "price_groups"("category_id");

-- CreateIndex
CREATE INDEX "price_groups_rev_idx" ON "price_groups"("rev");

-- CreateIndex
CREATE UNIQUE INDEX "products_code_key" ON "products"("code");

-- CreateIndex
CREATE INDEX "products_category_id_idx" ON "products"("category_id");

-- CreateIndex
CREATE INDEX "products_price_group_id_idx" ON "products"("price_group_id");

-- CreateIndex
CREATE INDEX "products_active_idx" ON "products"("active");

-- CreateIndex
CREATE INDEX "products_rev_idx" ON "products"("rev");

-- CreateIndex
CREATE INDEX "combo_items_component_product_id_idx" ON "combo_items"("component_product_id");

-- CreateIndex
CREATE UNIQUE INDEX "combo_items_combo_product_id_position_key" ON "combo_items"("combo_product_id", "position");

-- CreateIndex
CREATE INDEX "inventory_movements_product_id_created_at_idx" ON "inventory_movements"("product_id", "created_at");

-- CreateIndex
CREATE INDEX "inventory_movements_sale_id_idx" ON "inventory_movements"("sale_id");

-- CreateIndex
CREATE INDEX "inventory_movements_rev_idx" ON "inventory_movements"("rev");

-- CreateIndex
CREATE UNIQUE INDEX "customers_cedula_key" ON "customers"("cedula");

-- CreateIndex
CREATE INDEX "customers_name_idx" ON "customers"("name");

-- CreateIndex
CREATE INDEX "customers_rev_idx" ON "customers"("rev");

-- CreateIndex
CREATE INDEX "exchange_rates_source_created_at_idx" ON "exchange_rates"("source", "created_at" DESC);

-- CreateIndex
CREATE INDEX "exchange_rates_rev_idx" ON "exchange_rates"("rev");

-- CreateIndex
CREATE UNIQUE INDEX "payment_methods_name_key" ON "payment_methods"("name");

-- CreateIndex
CREATE INDEX "payment_methods_rev_idx" ON "payment_methods"("rev");

-- CreateIndex
CREATE UNIQUE INDEX "sales_number_key" ON "sales"("number");

-- CreateIndex
CREATE INDEX "sales_business_date_idx" ON "sales"("business_date");

-- CreateIndex
CREATE INDEX "sales_created_at_idx" ON "sales"("created_at");

-- CreateIndex
CREATE INDEX "sales_customer_id_idx" ON "sales"("customer_id");

-- CreateIndex
CREATE INDEX "sales_status_created_at_idx" ON "sales"("status", "created_at");

-- CreateIndex
CREATE INDEX "sales_order_id_idx" ON "sales"("order_id");

-- CreateIndex
CREATE INDEX "sales_rev_idx" ON "sales"("rev");

-- CreateIndex
CREATE INDEX "sale_items_product_id_idx" ON "sale_items"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "sale_items_sale_id_position_key" ON "sale_items"("sale_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "sale_payments_from_order_deposit_id_key" ON "sale_payments"("from_order_deposit_id");

-- CreateIndex
CREATE INDEX "sale_payments_business_date_idx" ON "sale_payments"("business_date");

-- CreateIndex
CREATE INDEX "sale_payments_method_id_idx" ON "sale_payments"("method_id");

-- CreateIndex
CREATE UNIQUE INDEX "sale_payments_sale_id_position_key" ON "sale_payments"("sale_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "orders_number_key" ON "orders"("number");

-- CreateIndex
CREATE INDEX "orders_status_idx" ON "orders"("status");

-- CreateIndex
CREATE INDEX "orders_created_at_idx" ON "orders"("created_at");

-- CreateIndex
CREATE INDEX "orders_customer_id_idx" ON "orders"("customer_id");

-- CreateIndex
CREATE INDEX "orders_business_date_idx" ON "orders"("business_date");

-- CreateIndex
CREATE INDEX "orders_rev_idx" ON "orders"("rev");

-- CreateIndex
CREATE INDEX "order_items_product_id_idx" ON "order_items"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_items_order_id_position_key" ON "order_items"("order_id", "position");

-- CreateIndex
CREATE INDEX "order_deposits_order_id_idx" ON "order_deposits"("order_id");

-- CreateIndex
CREATE INDEX "order_deposits_business_date_idx" ON "order_deposits"("business_date");

-- CreateIndex
CREATE INDEX "order_deposits_sale_id_idx" ON "order_deposits"("sale_id");

-- CreateIndex
CREATE INDEX "order_deposits_rev_idx" ON "order_deposits"("rev");

-- CreateIndex
CREATE UNIQUE INDEX "daily_closures_date_key" ON "daily_closures"("date");

-- CreateIndex
CREATE INDEX "daily_closures_rev_idx" ON "daily_closures"("rev");

-- CreateIndex
CREATE INDEX "audit_log_created_at_idx" ON "audit_log"("created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_entity_entity_id_idx" ON "audit_log"("entity", "entity_id");

-- CreateIndex
CREATE INDEX "audit_log_user_id_idx" ON "audit_log"("user_id");

-- CreateIndex
CREATE INDEX "audit_log_rev_idx" ON "audit_log"("rev");

-- CreateIndex
CREATE INDEX "devices_last_seen_at_idx" ON "devices"("last_seen_at");

-- CreateIndex
CREATE INDEX "sync_mutations_applied_at_idx" ON "sync_mutations"("applied_at");

-- CreateIndex
CREATE INDEX "sync_mutations_entity_entity_id_idx" ON "sync_mutations"("entity", "entity_id");

-- CreateIndex
CREATE INDEX "sync_mutations_device_id_applied_at_idx" ON "sync_mutations"("device_id", "applied_at");

-- CreateIndex
CREATE INDEX "sync_deletions_rev_idx" ON "sync_deletions"("rev");

-- CreateIndex
CREATE UNIQUE INDEX "sync_deletions_entity_entity_id_key" ON "sync_deletions"("entity", "entity_id");

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_groups" ADD CONSTRAINT "price_groups_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_group_prices" ADD CONSTRAINT "price_group_prices_price_group_id_fkey" FOREIGN KEY ("price_group_id") REFERENCES "price_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_group_prices" ADD CONSTRAINT "price_group_prices_price_type_id_fkey" FOREIGN KEY ("price_type_id") REFERENCES "price_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_price_group_id_fkey" FOREIGN KEY ("price_group_id") REFERENCES "price_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_price_type_id_fkey" FOREIGN KEY ("price_type_id") REFERENCES "price_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "combo_items" ADD CONSTRAINT "combo_items_combo_product_id_fkey" FOREIGN KEY ("combo_product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "combo_items" ADD CONSTRAINT "combo_items_component_product_id_fkey" FOREIGN KEY ("component_product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_voided_by_user_id_fkey" FOREIGN KEY ("voided_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_price_type_id_fkey" FOREIGN KEY ("price_type_id") REFERENCES "price_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_method_id_fkey" FOREIGN KEY ("method_id") REFERENCES "payment_methods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_from_order_deposit_id_fkey" FOREIGN KEY ("from_order_deposit_id") REFERENCES "order_deposits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_price_type_id_fkey" FOREIGN KEY ("price_type_id") REFERENCES "price_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_deposits" ADD CONSTRAINT "order_deposits_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_deposits" ADD CONSTRAINT "order_deposits_method_id_fkey" FOREIGN KEY ("method_id") REFERENCES "payment_methods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_deposits" ADD CONSTRAINT "order_deposits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_deposits" ADD CONSTRAINT "order_deposits_voided_by_user_id_fkey" FOREIGN KEY ("voided_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_deposits" ADD CONSTRAINT "order_deposits_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_deposits" ADD CONSTRAINT "order_deposits_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_closures" ADD CONSTRAINT "daily_closures_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "closure_methods" ADD CONSTRAINT "closure_methods_closure_id_fkey" FOREIGN KEY ("closure_id") REFERENCES "daily_closures"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "closure_methods" ADD CONSTRAINT "closure_methods_method_id_fkey" FOREIGN KEY ("method_id") REFERENCES "payment_methods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_cold_cake_category_id_fkey" FOREIGN KEY ("cold_cake_category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_mutations" ADD CONSTRAINT "sync_mutations_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ═════════════════════════════════════════════════════════════════════════════
-- 3 · DDL ESCRITO A MANO  (no lo genera Prisma · no lo borres al regenerar)
-- ═════════════════════════════════════════════════════════════════════════════

-- ─── 3.1 · Cursor de sincronización: `rev` lo asigna la base ──────────────────
-- La columna se declara en Prisma como `@default(0)` y el valor real lo pone
-- SIEMPRE este trigger, tanto en INSERT como en UPDATE. Así ninguna ruta de
-- escritura puede olvidarlo (Prisma, SQL crudo, un arreglo a mano en psql) y no
-- hay una segunda forma de mover el cursor.
--
-- ¿Por qué no `@default(dbgenerated("nextval('sync_rev_seq')"))`, que sería lo
-- obvio? Porque Prisma lo interpreta como una secuencia propiedad de la columna
-- y `prisma migrate diff` empieza a emitir, por cada tabla, un
-- `ALTER COLUMN rev DROP DEFAULT` + `DROP SEQUENCE sync_rev_seq`: la deriva
-- pasa a ser destructiva y la primera migración futura se lleva el mecanismo
-- entero por delante. Comprobado con `migrate diff --from-migrations` contra
-- este mismo esquema. Con `@default(0)` el diff sale vacío.
--
-- En UPDATE sólo bumpea si la fila cambió DE VERDAD: se comparan las dos
-- versiones ignorando `rev` y `updated_at`. Un UPDATE que no cambia nada no
-- mueve el cursor y no provoca un reenvío inútil a todos los dispositivos.
-- `updated_at` pasa a venir del reloj de la BD (un solo reloj, sin desfase
-- entre réplicas del backend).
CREATE OR REPLACE FUNCTION "sync_assign_rev"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.rev := nextval('sync_rev_seq');
    RETURN NEW;
  END IF;

  IF NEW.rev IS DISTINCT FROM OLD.rev THEN
    -- Bump explícito: viene de `sync_bump_parent_rev` (cambió una fila hija) o
    -- de una corrección deliberada. Se respeta tal cual; si no, el ELSE de más
    -- abajo lo desharía y el cambio del hijo nunca llegaría a los dispositivos.
    NEW.updated_at := now();
  ELSIF (to_jsonb(NEW) - 'rev' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'rev' - 'updated_at') THEN
    NEW.rev := nextval('sync_rev_seq');
    NEW.updated_at := now();
  ELSE
    NEW.rev := OLD.rev;
    NEW.updated_at := OLD.updated_at;
  END IF;
  RETURN NEW;
END $$;

-- Variante para las tablas append-only, que no tienen `updated_at` (y donde el
-- UPDATE está prohibido de todas formas).
CREATE OR REPLACE FUNCTION "sync_assign_rev_on_insert"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.rev := nextval('sync_rev_seq');
  RETURN NEW;
END $$;

CREATE TRIGGER "roles_assign_rev"            BEFORE INSERT OR UPDATE ON "roles"            FOR EACH ROW EXECUTE FUNCTION "sync_assign_rev"();
CREATE TRIGGER "users_assign_rev"            BEFORE INSERT OR UPDATE ON "users"            FOR EACH ROW EXECUTE FUNCTION "sync_assign_rev"();
CREATE TRIGGER "categories_assign_rev"       BEFORE INSERT OR UPDATE ON "categories"       FOR EACH ROW EXECUTE FUNCTION "sync_assign_rev"();
CREATE TRIGGER "price_types_assign_rev"      BEFORE INSERT OR UPDATE ON "price_types"      FOR EACH ROW EXECUTE FUNCTION "sync_assign_rev"();
CREATE TRIGGER "price_groups_assign_rev"     BEFORE INSERT OR UPDATE ON "price_groups"     FOR EACH ROW EXECUTE FUNCTION "sync_assign_rev"();
CREATE TRIGGER "products_assign_rev"         BEFORE INSERT OR UPDATE ON "products"         FOR EACH ROW EXECUTE FUNCTION "sync_assign_rev"();
CREATE TRIGGER "customers_assign_rev"        BEFORE INSERT OR UPDATE ON "customers"        FOR EACH ROW EXECUTE FUNCTION "sync_assign_rev"();
CREATE TRIGGER "payment_methods_assign_rev"  BEFORE INSERT OR UPDATE ON "payment_methods"  FOR EACH ROW EXECUTE FUNCTION "sync_assign_rev"();
CREATE TRIGGER "sales_assign_rev"            BEFORE INSERT OR UPDATE ON "sales"            FOR EACH ROW EXECUTE FUNCTION "sync_assign_rev"();
CREATE TRIGGER "orders_assign_rev"           BEFORE INSERT OR UPDATE ON "orders"           FOR EACH ROW EXECUTE FUNCTION "sync_assign_rev"();
CREATE TRIGGER "order_deposits_assign_rev"   BEFORE INSERT OR UPDATE ON "order_deposits"   FOR EACH ROW EXECUTE FUNCTION "sync_assign_rev"();
CREATE TRIGGER "daily_closures_assign_rev"   BEFORE INSERT OR UPDATE ON "daily_closures"   FOR EACH ROW EXECUTE FUNCTION "sync_assign_rev"();
CREATE TRIGGER "company_settings_assign_rev" BEFORE INSERT OR UPDATE ON "company_settings" FOR EACH ROW EXECUTE FUNCTION "sync_assign_rev"();

CREATE TRIGGER "inventory_movements_assign_rev" BEFORE INSERT ON "inventory_movements" FOR EACH ROW EXECUTE FUNCTION "sync_assign_rev_on_insert"();
CREATE TRIGGER "exchange_rates_assign_rev"      BEFORE INSERT ON "exchange_rates"      FOR EACH ROW EXECUTE FUNCTION "sync_assign_rev_on_insert"();
CREATE TRIGGER "audit_log_assign_rev"           BEFORE INSERT ON "audit_log"           FOR EACH ROW EXECUTE FUNCTION "sync_assign_rev_on_insert"();
CREATE TRIGGER "sync_deletions_assign_rev"      BEFORE INSERT ON "sync_deletions"      FOR EACH ROW EXECUTE FUNCTION "sync_assign_rev_on_insert"();

-- ⚠ Carga masiva: si alguna vez se importa con los triggers deshabilitados,
-- todas las filas quedan con rev = 0 y la sincronización nunca las envía.
-- Después de un import así hay que rellenar el cursor:
--   UPDATE <tabla> SET rev = nextval('sync_rev_seq') WHERE rev = 0;

-- ─── 3.2 · Bump del padre desde las filas hijas ───────────────────────────────
-- Las tablas hijas NO tienen `rev`: el delta viaja por agregados completos. Si
-- alguien cambia un precio de `product_prices` sin tocar `products`, el cursor
-- no se movería y los cajeros seguirían cobrando el precio viejo hasta el
-- siguiente bootstrap. Este trigger cierra ese agujero en la BD, en vez de
-- confiar en que cada servicio se acuerde de tocar el padre.
--
-- No se aplica a `sale_items`, `sale_payments` ni `closure_methods`: se insertan
-- una única vez junto a su padre (que ya nace con su `rev`) y nunca se editan,
-- así que el trigger sólo conseguiría dejar obsoleto el `rev` que la API acaba
-- de devolver.
CREATE OR REPLACE FUNCTION "sync_bump_parent_rev"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_table text := TG_ARGV[0];
  fk_column    text := TG_ARGV[1];
  parent_id    text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    parent_id := to_jsonb(OLD) ->> fk_column;
  ELSE
    parent_id := to_jsonb(NEW) ->> fk_column;
  END IF;
  IF parent_id IS NOT NULL THEN
    -- Si el padre se está borrando en la misma sentencia (CASCADE), el UPDATE
    -- simplemente no encuentra fila: no es un error.
    EXECUTE format('UPDATE %I SET rev = nextval(''sync_rev_seq''), updated_at = now() WHERE id = $1', parent_table)
      USING parent_id;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER "role_permissions_bump_parent"   AFTER INSERT OR UPDATE OR DELETE ON "role_permissions"   FOR EACH ROW EXECUTE FUNCTION "sync_bump_parent_rev"('roles', 'role_id');
CREATE TRIGGER "product_prices_bump_parent"     AFTER INSERT OR UPDATE OR DELETE ON "product_prices"     FOR EACH ROW EXECUTE FUNCTION "sync_bump_parent_rev"('products', 'product_id');
CREATE TRIGGER "price_group_prices_bump_parent" AFTER INSERT OR UPDATE OR DELETE ON "price_group_prices" FOR EACH ROW EXECUTE FUNCTION "sync_bump_parent_rev"('price_groups', 'price_group_id');
CREATE TRIGGER "combo_items_bump_parent"        AFTER INSERT OR UPDATE OR DELETE ON "combo_items"        FOR EACH ROW EXECUTE FUNCTION "sync_bump_parent_rev"('products', 'combo_product_id');
CREATE TRIGGER "order_items_bump_parent"        AFTER INSERT OR UPDATE OR DELETE ON "order_items"        FOR EACH ROW EXECUTE FUNCTION "sync_bump_parent_rev"('orders', 'order_id');

-- ─── 3.3 · Día contable (cierre de caja) ──────────────────────────────────────
-- El frontend calcula el día con `createdAt.slice(0,10)` sobre un ISO en UTC:
-- una venta de las 21:00 en Caracas (UTC-4) cae en el día siguiente y descuadra
-- el cierre. Aquí el día se deriva SIEMPRE de la zona del negocio y lo pone la
-- BD, no el servicio.
CREATE OR REPLACE FUNCTION "business_timezone"() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT "timezone" FROM "company_settings" WHERE "id" = 'singleton'), 'America/Caracas')
$$;

CREATE OR REPLACE FUNCTION "set_business_date_from_created_at"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.business_date := (COALESCE(NEW.created_at, now()) AT TIME ZONE "business_timezone"())::date;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION "set_business_date_from_at"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.business_date := (COALESCE(NEW.at, now()) AT TIME ZONE "business_timezone"())::date;
  RETURN NEW;
END $$;

-- Se dispara en TODO INSERT y TODO UPDATE, no sólo cuando cambia el timestamp
-- de origen: si sólo escuchara a `created_at`, un UPDATE que toca únicamente
-- `business_date` colaría un día falso y el cierre de caja se podría manipular.
CREATE TRIGGER "sales_set_business_date"          BEFORE INSERT OR UPDATE ON "sales"          FOR EACH ROW EXECUTE FUNCTION "set_business_date_from_created_at"();
CREATE TRIGGER "orders_set_business_date"         BEFORE INSERT OR UPDATE ON "orders"         FOR EACH ROW EXECUTE FUNCTION "set_business_date_from_created_at"();
CREATE TRIGGER "sale_payments_set_business_date"  BEFORE INSERT OR UPDATE ON "sale_payments"  FOR EACH ROW EXECUTE FUNCTION "set_business_date_from_at"();
CREATE TRIGGER "order_deposits_set_business_date" BEFORE INSERT OR UPDATE ON "order_deposits" FOR EACH ROW EXECUTE FUNCTION "set_business_date_from_at"();

-- ─── 3.4 · Tablas append-only: prohibido UPDATE y DELETE ──────────────────────
-- El kardex, el log de tasas y la bitácora son el rastro de auditoría: si se
-- pueden editar, no sirven como prueba de nada. Una corrección se hace con un
-- asiento nuevo (ajuste, tasa nueva, anulación), nunca reescribiendo el viejo.
-- Salida de emergencia documentada: ALTER TABLE ... DISABLE TRIGGER, dentro de
-- una migración explícita y revisada.
CREATE OR REPLACE FUNCTION "forbid_row_rewrite"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% es append-only: % no esta permitido', TG_TABLE_NAME, TG_OP
    USING HINT = 'Corrige con un asiento nuevo (ajuste de inventario, tasa nueva, anulacion). Para un arreglo excepcional: ALTER TABLE ... DISABLE TRIGGER en una migracion revisada.';
END $$;

CREATE TRIGGER "inventory_movements_append_only" BEFORE UPDATE OR DELETE ON "inventory_movements" FOR EACH ROW EXECUTE FUNCTION "forbid_row_rewrite"();
CREATE TRIGGER "exchange_rates_append_only"      BEFORE UPDATE OR DELETE ON "exchange_rates"      FOR EACH ROW EXECUTE FUNCTION "forbid_row_rewrite"();
CREATE TRIGGER "audit_log_append_only"           BEFORE UPDATE OR DELETE ON "audit_log"           FOR EACH ROW EXECUTE FUNCTION "forbid_row_rewrite"();

-- ─── 3.5 · Índices únicos PARCIALES ───────────────────────────────────────────
-- ⚠ Son los dos objetos de este bloque que Prisma SÍ puede ver (los índices los
-- modela; el predicado WHERE no). Al regenerar migraciones hay que borrar del
-- script cualquier DROP contra ellos.

-- Un pedido no puede facturarse dos veces. Es la red de seguridad contra el caso
-- offline clásico: dos cajas procesan el mismo pedido sin verse y al reconectar
-- la segunda venta choca aquí en lugar de duplicar el cobro. Anular la venta
-- (status = 'anulada') libera el pedido para volver a facturarlo.
CREATE UNIQUE INDEX "sales_active_order_uq" ON "sales" ("order_id")
  WHERE "order_id" IS NOT NULL AND "status" = 'completada';

-- Un solo tipo de precio por defecto.
CREATE UNIQUE INDEX "price_types_single_default_uq" ON "price_types" (("is_default"))
  WHERE "is_default";

-- ─── 3.6 · CHECK de integridad ────────────────────────────────────────────────
-- Prisma no expresa CHECK y tampoco los ve en el diff, así que sobreviven a
-- cualquier regeneración. Codifican invariantes del negocio que hoy viven sólo
-- en el código del frontend.

-- Configuración: una única fila.
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_singleton_ck" CHECK ("id" = 'singleton');

-- El usuario técnico nunca puede estar activo (refuerza el guardia del login).
ALTER TABLE "users" ADD CONSTRAINT "users_system_not_active_ck" CHECK ("system" = false OR "active" = false);

-- Regla de precio (PriceRule aplanada). Hay que poder distinguir "grupo sin
-- regla" de "grupo con regla y sin banda": sólo un grupo CON banda bloquea una
-- venta (lib/pricing.priceBandCheck).
ALTER TABLE "price_groups"
  ADD CONSTRAINT "price_groups_rule_pair_ck"  CHECK (("rule_min_usd" IS NULL) = ("rule_target_usd" IS NULL)),
  ADD CONSTRAINT "price_groups_band_pair_ck"  CHECK (("rule_band_min_usd" IS NULL) = ("rule_band_max_usd" IS NULL)),
  ADD CONSTRAINT "price_groups_band_needs_rule_ck" CHECK ("rule_band_min_usd" IS NULL OR "rule_min_usd" IS NOT NULL),
  ADD CONSTRAINT "price_groups_band_order_ck" CHECK ("rule_band_min_usd" IS NULL OR "rule_band_min_usd" <= "rule_band_max_usd"),
  ADD CONSTRAINT "price_groups_rule_min_positive_ck" CHECK ("rule_min_usd" IS NULL OR "rule_min_usd" > 0),
  -- El objetivo de la alerta nunca por debajo del umbral: la migración v2 del
  -- frontend existió justamente para arreglar eso (max 1,20 < objetivo 1,30
  -- bloqueaba la corrección que la propia alerta pedía).
  ADD CONSTRAINT "price_groups_target_ge_min_ck" CHECK ("rule_target_usd" IS NULL OR "rule_target_usd" >= "rule_min_usd");

-- Producto con precio fijado en Bs: tiene que traer el precio en Bs.
ALTER TABLE "products"
  ADD CONSTRAINT "products_bs_only_needs_price_ck" CHECK ("bs_only" = false OR "bs_price" IS NOT NULL),
  ADD CONSTRAINT "products_min_stock_ck" CHECK ("min_stock" >= 0),
  ADD CONSTRAINT "products_customization_price_ck" CHECK ("customization_price" IS NULL OR "customization_price" >= 0);
-- Nota: `stock` puede ser negativo a propósito (un POS tiene que poder vender
-- lo que el conteo dice que no hay y cuadrarlo después con un ajuste).

ALTER TABLE "product_prices"     ADD CONSTRAINT "product_prices_amount_ck"     CHECK ("amount" >= 0);
ALTER TABLE "price_group_prices" ADD CONSTRAINT "price_group_prices_amount_ck" CHECK ("amount" >= 0);
ALTER TABLE "combo_items"        ADD CONSTRAINT "combo_items_qty_ck"           CHECK ("qty" > 0);

-- Cédula normalizada en mayúsculas: la unicidad no sirve de nada si la misma
-- persona entra como "v-123" y "V-123".
ALTER TABLE "customers"
  ADD CONSTRAINT "customers_cedula_upper_ck" CHECK ("cedula" = upper("cedula")),
  ADD CONSTRAINT "customers_cedula_not_blank_ck" CHECK (length(btrim("cedula")) > 0),
  ADD CONSTRAINT "customers_name_not_blank_ck" CHECK (length(btrim("name")) > 0);

ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_value_ck" CHECK ("value" > 0);

-- Kardex: la relación entre tipo, cantidad y efecto queda garantizada por la BD.
--   entrada → delta = +qty · salida → delta = −qty · ajuste → stock_after = qty
-- Así es imposible asentar un movimiento que mienta sobre su propio efecto.
ALTER TABLE "inventory_movements"
  ADD CONSTRAINT "inventory_movements_qty_ck" CHECK ("qty" >= 0),
  ADD CONSTRAINT "inventory_movements_qty_positive_ck" CHECK ("type" = 'ajuste' OR "qty" > 0),
  ADD CONSTRAINT "inventory_movements_delta_ck" CHECK (
    ("type" = 'entrada' AND "delta" =  "qty") OR
    ("type" = 'salida'  AND "delta" = -"qty") OR
    ("type" = 'ajuste'  AND "stock_after" = "qty")
  );

-- Ventas: inmutables salvo la anulación, que tiene que quedar fechada.
ALTER TABLE "sales"
  ADD CONSTRAINT "sales_total_ck" CHECK ("total_usd" >= 0),
  ADD CONSTRAINT "sales_change_ck" CHECK ("change_usd" IS NULL OR "change_usd" >= 0),
  ADD CONSTRAINT "sales_voided_needs_date_ck" CHECK ("status" <> 'anulada' OR "voided_at" IS NOT NULL);

ALTER TABLE "sale_items"
  ADD CONSTRAINT "sale_items_qty_ck" CHECK ("qty" > 0),
  ADD CONSTRAINT "sale_items_position_ck" CHECK ("position" >= 0),
  ADD CONSTRAINT "sale_items_subtotal_ck" CHECK ("subtotal_usd" >= 0),
  ADD CONSTRAINT "sale_items_bs_only_needs_price_ck" CHECK ("bs_only" = false OR "unit_price_bs" IS NOT NULL);

-- Un cobro en Bs sin la tasa con la que se calculó no es auditable.
ALTER TABLE "sale_payments"
  ADD CONSTRAINT "sale_payments_amount_ck" CHECK ("amount" > 0),
  ADD CONSTRAINT "sale_payments_usd_ck" CHECK ("usd_equivalent" >= 0),
  ADD CONSTRAINT "sale_payments_bs_needs_rate_ck" CHECK ("currency" <> 'BS' OR "rate_used" IS NOT NULL),
  ADD CONSTRAINT "sale_payments_position_ck" CHECK ("position" >= 0);

-- Pedidos: un pedido procesado tiene que apuntar a su venta, y uno cancelado
-- tiene que estar fechado.
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_total_ck" CHECK ("total_usd" >= 0),
  ADD CONSTRAINT "orders_processed_needs_sale_ck" CHECK ("status" <> 'procesado' OR "sale_id" IS NOT NULL),
  ADD CONSTRAINT "orders_canceled_needs_date_ck" CHECK ("status" <> 'cancelado' OR "canceled_at" IS NOT NULL);

ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_qty_ck" CHECK ("qty" > 0),
  ADD CONSTRAINT "order_items_position_ck" CHECK ("position" >= 0),
  ADD CONSTRAINT "order_items_subtotal_ck" CHECK ("subtotal_usd" >= 0),
  ADD CONSTRAINT "order_items_bs_only_needs_price_ck" CHECK ("bs_only" = false OR "unit_price_bs" IS NOT NULL);

-- Abonos: dinero que ya entró. Monto y tasa congelada siempre presentes; una
-- anulación siempre fechada.
ALTER TABLE "order_deposits"
  ADD CONSTRAINT "order_deposits_amount_ck" CHECK ("amount" > 0),
  ADD CONSTRAINT "order_deposits_usd_ck" CHECK ("usd_equivalent" > 0),
  ADD CONSTRAINT "order_deposits_rate_ck" CHECK ("rate_used" > 0),
  ADD CONSTRAINT "order_deposits_voided_needs_date_ck" CHECK ("voided" = false OR "voided_at" IS NOT NULL);

-- Cierre de caja: la diferencia es exactamente lo contado menos lo esperado.
ALTER TABLE "daily_closures"
  ADD CONSTRAINT "daily_closures_count_ck" CHECK ("sales_count" >= 0),
  ADD CONSTRAINT "daily_closures_difference_ck" CHECK ("difference_usd" = "received_usd" - "expected_usd");

-- ─── 3.7 · Un código retirado no se puede reutilizar ──────────────────────────
-- `products.code` único sólo impide choques entre productos VIVOS. La regla que
-- de verdad importa es que un código retirado no vuelva a circular: si "P001"
-- se reasigna, un comprobante viejo que dice "P001 · tres-leches" pasa a
-- resolver a otro producto. No hay FK que exprese "no está en esta otra tabla",
-- así que va como trigger.
CREATE OR REPLACE FUNCTION "products_reject_retired_code"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "retired_product_codes" WHERE "code" = NEW.code) THEN
    RAISE EXCEPTION 'El codigo % esta retirado y no se puede reutilizar', NEW.code
      USING HINT = 'Asigna el siguiente codigo libre. Si el retiro fue un error, borra su fila de retired_product_codes.';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "products_reject_retired_code" BEFORE INSERT OR UPDATE OF "code" ON "products"
  FOR EACH ROW EXECUTE FUNCTION "products_reject_retired_code"();

-- ─── 3.8 · Filas de infraestructura ───────────────────────────────────────────
-- No es catálogo de negocio (eso va en el seed): son las filas de las que
-- dependen las FKs y la configuración para que un despliegue nuevo arranque.

-- Usuario técnico dueño de los asientos que genera el servidor. El frontend
-- resuelve el nombre del usuario de cada movimiento por id; con una fila real
-- muestra "Sistema" en lugar de un hueco, y las FKs siguen siendo NOT NULL.
-- El hash es un literal inválido para argon2: ninguna contraseña puede igualarlo.
INSERT INTO "roles" ("id", "name", "system", "created_at", "updated_at")
VALUES ('role-system', 'Sistema', true, now(), now());

INSERT INTO "users" ("id", "username", "full_name", "password_hash", "role_id", "active", "system", "created_at", "updated_at")
VALUES ('system', 'system', 'Sistema', '!no-login!', 'role-system', false, true, now(), now());

-- Configuración de la empresa (fila única). El resto de campos toma el default.
INSERT INTO "company_settings" ("id", "name", "created_at", "updated_at")
VALUES ('singleton', 'Karelys Delicias', now(), now());

-- Códigos retirados: los 13 sabores de tortas frías que el esquema v3 del
-- frontend consolidó en un producto único. Sus códigos no se reparten nunca más,
-- para que un comprobante viejo que dice "P001 · tres-leches" no pueda resolver
-- a un producto distinto.
INSERT INTO "retired_product_codes" ("code", "former_name", "reason") VALUES
  ('P001', 'tres-leches',    'Consolidacion de sabores de Tortas Frias (esquema v3)'),
  ('P002', 'milhojas',       'Consolidacion de sabores de Tortas Frias (esquema v3)'),
  ('P003', 'fresa',          'Consolidacion de sabores de Tortas Frias (esquema v3)'),
  ('P004', 'arequipe',       'Consolidacion de sabores de Tortas Frias (esquema v3)'),
  ('P005', 'torta suiza',    'Consolidacion de sabores de Tortas Frias (esquema v3)'),
  ('P006', 'chocolate',      'Consolidacion de sabores de Tortas Frias (esquema v3)'),
  ('P007', 'choco-leche',    'Consolidacion de sabores de Tortas Frias (esquema v3)'),
  ('P008', 'choco-fresa',    'Consolidacion de sabores de Tortas Frias (esquema v3)'),
  ('P009', 'mani',           'Consolidacion de sabores de Tortas Frias (esquema v3)'),
  ('P010', 'choco-mani',     'Consolidacion de sabores de Tortas Frias (esquema v3)'),
  ('P011', 'choco-arequipe', 'Consolidacion de sabores de Tortas Frias (esquema v3)'),
  ('P012', 'prestigio',      'Consolidacion de sabores de Tortas Frias (esquema v3)'),
  ('P013', 'tornado',        'Consolidacion de sabores de Tortas Frias (esquema v3)');
