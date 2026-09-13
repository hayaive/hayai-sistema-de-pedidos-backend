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
import { depositOut } from '../common/serialize';
import { IfMatch } from '../common/if-match';
import { AppError } from '../common/errors';
import { DepositsService } from './deposits.service';
import { OrdersService } from './orders.service';
import {
  CreateDepositDto,
  CreateOrderDto,
  OrdersQueryDto,
  SetOrderStatusDto,
  UpdateOrderDto,
  VoidDepositDto,
} from './dto/order.dto';

@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly deposits: DepositsService,
  ) {}

  @Get()
  @RequirePermission('view_orders')
  list(@Query() query: OrdersQueryDto) {
    return this.orders.list(query);
  }

  /** Pedidos con saldo pendiente, para la vista de cobros. */
  @Get('pending-balance')
  @RequirePermission('view_orders')
  pending() {
    return this.orders.withPendingBalance();
  }

  @Get(':id')
  @RequirePermission('view_orders')
  async getOne(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const out = await this.orders.getOne(id);
    res.setHeader('ETag', String(out.rev));
    return out;
  }

  @Post()
  @RequirePermission('edit_orders')
  async create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateOrderDto,
    @DeviceId() deviceId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { order, renumbered } = await this.orders.create(user, dto, { deviceId });
    res.setHeader('ETag', String(order.rev));
    return { ...this.orders.withBalance(order), ...(renumbered ? { renumbered } : {}) };
  }

  /**
   * `If-Match` **obligatorio** (§6.7): el pedido es el único agregado con edición
   * concurrente real, y sin la precondición dos cajas se pisarían las líneas.
   */
  @Patch(':id')
  @RequirePermission('edit_orders')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateOrderDto,
    @IfMatch() ifMatch: number | null,
    @Res({ passthrough: true }) res: Response,
  ) {
    const baseRev = ifMatch ?? dto.baseRev ?? null;
    if (baseRev === null) {
      throw new AppError(
        'precondition_required',
        'PATCH /orders/:id exige If-Match con el rev actual del pedido',
      );
    }

    const { order, statusIgnored } = await this.orders.update(user, id, dto, { baseRev });
    res.setHeader('ETag', String(order.rev));
    return { ...this.orders.withBalance(order), ...(statusIgnored ? { statusIgnored } : {}) };
  }

  /** Sólo hacia adelante: una transición que retrocede se ignora y se audita. */
  @Post(':id/status')
  @RequirePermission('edit_orders', 'process_orders')
  async setStatus(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: SetOrderStatusDto,
    @IfMatch() ifMatch: number | null,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { order, statusIgnored } = await this.orders.setStatus(user, id, dto, {
      baseRev: ifMatch ?? dto.baseRev ?? null,
    });
    res.setHeader('ETag', String(order.rev));
    return { ...this.orders.withBalance(order), ...(statusIgnored ? { statusIgnored } : {}) };
  }

  @Get(':id/deposits')
  @RequirePermission('view_orders')
  listDeposits(@Param('id') id: string) {
    return this.orders.depositsOf(id);
  }

  /** En línea el abono se valida contra el saldo pendiente (§5). */
  @Post(':id/deposits')
  @RequirePermission('edit_orders', 'process_orders')
  async addDeposit(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: CreateDepositDto,
    @DeviceId() deviceId: string,
  ) {
    const deposit = await this.deposits.createOnline(user, id, dto, deviceId);
    const order = await this.orders.aggregate(id);
    return { deposit: depositOut(deposit), order: this.orders.withBalance(order) };
  }

  /** Anular es idempotente y gana sobre no anular. */
  @Post(':id/deposits/:depositId/void')
  @RequirePermission('edit_orders', 'process_orders')
  async voidDeposit(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('depositId') depositId: string,
    @Body() dto: VoidDepositDto,
  ) {
    const deposit = await this.deposits.voidOnline(user, id, depositId, dto.reason);
    const order = await this.orders.aggregate(id);
    return { deposit: depositOut(deposit), order: this.orders.withBalance(order) };
  }

  /** Se niega si tiene abonos vigentes: es dinero que ya entró a caja. */
  @Delete(':id')
  @RequirePermission('edit_orders')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<void> {
    await this.orders.remove(user, id);
  }
}
