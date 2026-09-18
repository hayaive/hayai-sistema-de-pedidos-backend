-- ═════════════════════════════════════════════════════════════════════════════
-- Stock nunca negativo
--
-- Regla del negocio (2026-09-18): se puede vender sin existencia, pero la
-- existencia nunca baja de 0. Una `salida` guarda en `qty` lo pedido y en
-- `delta` lo que de verdad se descontó: −min(qty, stock). El faltante
-- ("vendido sin existencia") es derivable: qty + delta.
--
-- 1 · El CHECK del kardex admite la salida recortada, pero sólo si deja la
--     existencia exactamente en 0: una salida no puede descontar "de menos"
--     y dejar existencia. Todas las filas históricas (delta = −qty) siguen
--     siendo válidas, así que el CHECK entra validado.
-- 2 · Backfill: cada producto en negativo recibe un `ajuste` a 0 firmado por
--     el usuario técnico `system`, para que SUM(delta) = stock siga cuadrando.
-- 3 · CHECK (stock >= 0) en products, validado (el backfill ya lo cumple).
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE "inventory_movements" DROP CONSTRAINT "inventory_movements_delta_ck";
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_delta_ck" CHECK (
  ("type" = 'entrada' AND "delta" = "qty") OR
  ("type" = 'salida'  AND "delta" <= 0 AND "delta" >= -"qty"
                      AND ("delta" = -"qty" OR "stock_after" = 0)) OR
  ("type" = 'ajuste'  AND "stock_after" = "qty")
);

INSERT INTO "inventory_movements"
  ("id", "product_id", "type", "qty", "delta", "stock_after", "reason", "note", "user_id", "created_at")
SELECT 'stock0-' || md5(p."id"), p."id", 'ajuste', 0, -p."stock", 0,
       'Corrección: stock negativo a cero',
       'Migración 20260918130000_stock_never_negative. Faltante absorbido: ' || (-p."stock")::text,
       'system', now()
  FROM "products" p
 WHERE p."stock" < 0;

UPDATE "products" SET "stock" = 0, "updated_at" = now() WHERE "stock" < 0;

ALTER TABLE "products" ADD CONSTRAINT "products_stock_nonneg_ck" CHECK ("stock" >= 0);
