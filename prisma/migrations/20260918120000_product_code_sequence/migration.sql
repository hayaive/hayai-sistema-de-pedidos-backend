-- ═════════════════════════════════════════════════════════════════════════════
-- Secuencia automática de códigos de producto (Ajustes)
--
-- `product_code_start` es un PISO configurable, no un contador: el código
-- sugerido es el menor número libre ≥ piso en la serie `prefijo+dígitos`
-- (productos vivos ∪ retired_product_codes). El servidor NUNCA avanza esta
-- columna al crear un producto — eso subiría `company_settings.rev` en cada
-- alta y rompería la sincronización de Ajustes. Ver ARCHITECTURE.md y
-- `ProductsService.nextFreeCode`.
--
-- El backfill deja el piso en el primer número libre de la serie "P" +
-- dígitos ya usada por los productos/retirados/líneas de venta y pedido
-- existentes, para no proponer un código que ya está en circulación.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE "company_settings"
  ADD COLUMN "product_code_prefix" VARCHAR(8) NOT NULL DEFAULT 'P',
  ADD COLUMN "product_code_digits" INTEGER    NOT NULL DEFAULT 3,
  ADD COLUMN "product_code_start"  INTEGER    NOT NULL DEFAULT 1;

ALTER TABLE "company_settings"
  ADD CONSTRAINT "company_settings_product_code_prefix_ck" CHECK ("product_code_prefix" ~ '^[A-Z]([A-Z0-9-]{0,6}[A-Z-])?$'),
  ADD CONSTRAINT "company_settings_product_code_digits_ck" CHECK ("product_code_digits" BETWEEN 1 AND 6),
  ADD CONSTRAINT "company_settings_product_code_start_ck"  CHECK ("product_code_start" BETWEEN 1 AND 99999999);

UPDATE "company_settings" SET "product_code_start" = COALESCE((
  SELECT MAX(substring(c FROM '^P([0-9]{1,8})$')::int) + 1 FROM (
    SELECT "code" AS c FROM "products" UNION ALL SELECT "code" FROM "retired_product_codes"
    UNION ALL SELECT "code" FROM "sale_items" UNION ALL SELECT "code" FROM "order_items") x), 1)
WHERE "id" = 'singleton';
