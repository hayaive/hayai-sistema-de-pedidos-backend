-- Precio sujeto al rango de la empresa, por producto.
--
-- Hasta ahora la banda mínimo/máximo (company_settings.cold_cake_min/max)
-- colgaba sólo del producto genérico "Tortas Frías" (P060). Desde aquí el
-- negocio decide qué productos quedan sujetos al rango, y el genérico se marca
-- para que su alerta siga funcionando igual que antes.
ALTER TABLE "products" ADD COLUMN "price_band" BOOLEAN NOT NULL DEFAULT false;

UPDATE "products"
   SET "price_band" = true, "updated_at" = now()
 WHERE "id" = 'prod-P060' OR "code" = 'P060';
