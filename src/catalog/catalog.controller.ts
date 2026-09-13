import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser, DeviceId, RequirePermission } from '../auth/decorators';
import { IfMatch } from '../common/if-match';
import { priceGroupOut, productOut } from '../common/serialize';
import { InventoryService } from '../inventory/inventory.service';
import { CreateMovementDto } from '../inventory/dto/movement.dto';
import { CategoriesService } from './categories.service';
import { PriceGroupsService } from './price-groups.service';
import { PriceTypesService } from './price-types.service';
import { ProductsService } from './products.service';
import {
  CreateCategoryDto,
  CreatePriceGroupDto,
  CreatePriceTypeDto,
  UpdateCategoryDto,
  UpdatePriceGroupDto,
  UpdatePriceTypeDto,
} from './dto/catalog.dto';
import {
  CreateProductDto,
  ProductsQueryDto,
  SetPriceDto,
  UpdateProductDto,
} from './dto/product.dto';

@Controller('products')
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly inventory: InventoryService,
  ) {}

  @Get()
  @RequirePermission('view_inventory', 'create_sale')
  list(@Query() query: ProductsQueryDto) {
    return this.products.list(query);
  }

  @Get(':id')
  @RequirePermission('view_inventory', 'create_sale')
  getOne(@Param('id') id: string) {
    return this.products.getOne(id);
  }

  @Post()
  @RequirePermission('edit_inventory')
  async create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateProductDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    // En línea NO se recodifica en silencio: si el código ya existe es un error
    // del usuario y tiene que verlo. La recodificación automática es para la cola
    // offline, donde el choque lo produjeron dos dispositivos sin verse.
    const { product } = await this.products.create(user, dto);
    res.setHeader('ETag', String(product.rev));
    return productOut(product);
  }

  /** `If-Match` opcional (§6.7): en productos el choque concurrente es raro. */
  @Patch(':id')
  @RequirePermission('edit_inventory')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
    @IfMatch() ifMatch: number | null,
    @Res({ passthrough: true }) res: Response,
  ) {
    const product = await this.products.update(user, id, dto, { ifMatch });
    res.setHeader('ETag', String(product.rev));
    return productOut(product);
  }

  /** 409 si tiene historial; retira el código para que no vuelva a circular. */
  @Delete(':id')
  @RequirePermission('edit_inventory')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<void> {
    await this.products.remove(user, id);
  }

  /** Precio propio por celda `(producto, tipo de precio)`. */
  @Post(':id/prices')
  @RequirePermission('edit_inventory')
  async setPrice(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: SetPriceDto,
  ) {
    return productOut(await this.products.setPrice(user, id, dto));
  }

  /** La única vía para mover la existencia: `stock` no es escribible. */
  @Post(':id/movements')
  @RequirePermission('edit_inventory')
  createMovement(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: CreateMovementDto,
    @DeviceId() deviceId: string,
  ) {
    return this.inventory.create(user, id, dto, deviceId);
  }
}

@Controller('categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  list() {
    return this.categories.list();
  }

  @Post()
  @RequirePermission('manage_settings', 'edit_inventory')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateCategoryDto) {
    return this.categories.create(user, dto);
  }

  @Patch(':id')
  @RequirePermission('manage_settings', 'edit_inventory')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.categories.update(user, id, dto);
  }

  @Delete(':id')
  @RequirePermission('manage_settings')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<void> {
    await this.categories.remove(user, id);
  }
}

@Controller('price-types')
export class PriceTypesController {
  constructor(private readonly priceTypes: PriceTypesService) {}

  @Get()
  list() {
    return this.priceTypes.list();
  }

  @Post()
  @RequirePermission('manage_settings')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreatePriceTypeDto) {
    return this.priceTypes.create(user, dto);
  }

  @Patch(':id')
  @RequirePermission('manage_settings')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdatePriceTypeDto) {
    return this.priceTypes.update(user, id, dto);
  }

  @Delete(':id')
  @RequirePermission('manage_settings')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<void> {
    await this.priceTypes.remove(user, id);
  }
}

@Controller('price-groups')
export class PriceGroupsController {
  constructor(private readonly priceGroups: PriceGroupsService) {}

  @Get()
  list() {
    return this.priceGroups.list();
  }

  @Post()
  @RequirePermission('edit_inventory', 'manage_settings')
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreatePriceGroupDto) {
    return priceGroupOut(await this.priceGroups.create(user, dto));
  }

  @Patch(':id')
  @RequirePermission('edit_inventory', 'manage_settings')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdatePriceGroupDto,
    @IfMatch() ifMatch: number | null,
    @Res({ passthrough: true }) res: Response,
  ) {
    const group = await this.priceGroups.update(user, id, dto, { ifMatch });
    res.setHeader('ETag', String(group.rev));
    return priceGroupOut(group);
  }

  /**
   * El precio del grupo por celda. Cambiarlo cambia el precio de **todos** sus
   * miembros a la vez: es el "precio general".
   */
  @Post(':id/prices')
  @RequirePermission('edit_inventory', 'manage_settings')
  async setPrice(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: SetPriceDto,
  ) {
    return priceGroupOut(await this.priceGroups.setPrice(user, id, dto));
  }

  @Delete(':id')
  @RequirePermission('manage_settings')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<void> {
    await this.priceGroups.remove(user, id);
  }
}
