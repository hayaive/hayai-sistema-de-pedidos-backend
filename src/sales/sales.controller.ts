import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser, DeviceId, RequirePermission } from '../auth/decorators';
import { saleOut } from '../common/serialize';
import { SalesService } from './sales.service';
import { CreateSaleDto, SalesQueryDto, VoidSaleDto } from './dto/sale.dto';

@Controller('sales')
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  /** `from`/`to` filtran por **día contable**, no por `createdAt` en UTC. */
  @Get()
  @RequirePermission('view_sales')
  list(@Query() query: SalesQueryDto) {
    return this.sales.list(query);
  }

  @Get(':id')
  @RequirePermission('view_sales')
  getOne(@Param('id') id: string) {
    return this.sales.getOne(id);
  }

  /**
   * Alta de venta. Mueve inventario, consume los abonos del pedido y asigna el
   * número definitivo, todo en una transacción.
   */
  @Post()
  @RequirePermission('create_sale')
  async create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateSaleDto,
    @DeviceId() deviceId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { sale, duplicate, renumbered } = await this.sales.create(user, dto, { deviceId });
    res.setHeader('ETag', String(sale.rev));
    return {
      ...saleOut(sale),
      ...(duplicate ? { duplicate: true } : {}),
      ...(renumbered ? { renumbered } : {}),
    };
  }

  /** Anulación idempotente: devuelve el stock una sola vez. */
  @Post(':id/void')
  @RequirePermission('cancel_sale')
  async void(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: VoidSaleDto,
    @DeviceId() deviceId: string,
  ) {
    const { sale, alreadyVoided } = await this.sales.void(user, id, dto.reason, { deviceId });
    return { ...saleOut(sale), ...(alreadyVoided ? { alreadyVoided: true } : {}) };
  }
}
