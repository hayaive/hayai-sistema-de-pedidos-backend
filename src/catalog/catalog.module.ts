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
 * resolver precios, bandas y productos.
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
