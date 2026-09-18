-- Precios en Bs por tipo de precio (Mayor, Detal…) para productos bs_only.
--
-- Hasta ahora un producto en Bs tenía un único `bs_price`. Desde aquí puede
-- tener uno por tipo de precio, guardado como arreglo JSON
-- `[{ "priceTypeId": …, "amount": … }]` (montos en Bs). Va aparte de
-- `product_prices`, que son USD, para no reinterpretar la moneda de ninguna fila
-- existente. `NULL` (todos los productos actuales) = `bs_price` vale para todos
-- los tipos, que es exactamente el comportamiento de antes.
ALTER TABLE "products" ADD COLUMN "bs_prices" JSONB;

ALTER TABLE "products" ADD CONSTRAINT "products_bs_prices_array_ck"
  CHECK ("bs_prices" IS NULL OR jsonb_typeof("bs_prices") = 'array');
