import { Global, Module } from '@nestjs/common';
import {
  CategoriesController,
  PriceGroupsController,
  PriceTypesController,
  ProductsController,
} from './catalog.controller';
import { CategoriesService } from './categories.service';
import { PriceGroupsService } from './price-groups.service';
import { PriceTypesService } from './price-types.service';
import { PricingService } from './pricing.service';
import { ProductsService } from './products.service';

/**
 * Global porque `sync` (los handlers de mutación), `sales` y `orders` necesitan
 * resolver precios y productos.
 *
 * `PriceGroupsService` y su controlador siguen registrados **sólo por
 * compatibilidad**: el mecanismo de grupos de precio se retiró en 2026-09 y no
 * influye ya en ningún precio, pero las rutas se mantienen vivas mientras queden
 * clientes v5 en circulación (ver `price-groups.service.ts`).
 */
@Global()
@Module({
  controllers: [
    ProductsController,
    CategoriesController,
    PriceTypesController,
    PriceGroupsController,
  ],
  providers: [
    ProductsService,
    CategoriesService,
    PriceTypesService,
    PriceGroupsService,
    PricingService,
  ],
  exports: [ProductsService, CategoriesService, PriceTypesService, PriceGroupsService, PricingService],
})
export class CatalogModule {}
