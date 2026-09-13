import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../generated/prisma/client';
import { OrderStatus } from '../generated/prisma/enums';
import { AppError, invalid, notFound } from '../common/errors';
import { ORDER_INCLUDE } from '../common/includes';
import { buildLines, orderItemRows, orderTotalOf } from '../common/lines';
import { Dec, dec, EPS, usd as usdScale, zero } from '../common/money';
import { depositOut, orderOut } from '../common/serialize';
import { clampClientTime } from '../common/time';
import { Tx } from '../common/tx';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.types';
import { CompanyService } from '../company/company.service';
import { PrismaService } from '../prisma/prisma.service';
import { TombstonesService } from '../sync/tombstones.service';
import { DepositsService } from './deposits.service';
import {
  CreateOrderDto,
  OrdersQueryDto,
  SetOrderStatusDto,
  UpdateOrderDto,
} from './dto/order.dto';
import { advances, isTerminal, orderBalance, OrderStatusName } from './order-balance';

export type OrderAggregate = Prisma.OrderGetPayload<{ include: typeof ORDER_INCLUDE }>;

/** Lo que devuelve una mutación de pedido, con lo que el cliente necesita adoptar. */
export interface OrderResult {
  order: OrderAggregate;
  renumbered?: { from: string; to: string };
  /** Transición ignorada por no avanzar (§5): se informa, no se aplica. */
  statusIgnored?: { requested: OrderStatus; current: OrderStatus };
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly company: CompanyService,
    private readonly deposits: DepositsService,
    private readonly audit: AuditService,
    private readonly tombstones: TombstonesService,
  ) {}

  async aggregate(id: string, db: Tx | PrismaService = this.prisma): Promise<OrderAggregate> {
    const row = await db.order.findUnique({ where: { id }, include: ORDER_INCLUDE });
    if (!row) throw notFound('El pedido');
    return row;
  }

  /** El pedido con su saldo derivado, que es lo que la UI de cobros necesita. */
  withBalance(order: OrderAggregate) {
    const balance = orderBalance(dec(order.totalUsd), order.deposits);
    return {
      ...orderOut(order),
      balance: {
        totalUsd: balance.totalUsd.toNumber(),
        depositUsd: balance.depositUsd.toNumber(),
        balanceUsd: balance.balanceUsd.toNumber(),
        overpaidUsd: balance.overpaidUsd.toNumber(),
        status: balance.status,
      },
    };
  }

  async list(query: OrdersQueryDto) {
    const where: Prisma.OrderWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        include: ORDER_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return {
      page: query.page,
      pageSize: query.pageSize,
      total,
      items: rows.map((o) => this.withBalance(o)),
    };
  }

  async getOne(id: string) {
    return this.withBalance(await this.aggregate(id));
  }

  /**
   * Crea el pedido y, si el cliente adelantó dinero, registra el abono **en el
   * mismo acto**: si el abono es inválido no se crea nada, porque un pedido a
   * medias con el cobro sin registrar es peor que ningún pedido
   * (`lib/business.createOrder`).
   *
   * El número lo asigna siempre el servidor. Si el cliente traía uno provisional
   * distinto, se guarda en `clientNumber` (para encontrar el pedido por el
   * comprobante que ya se imprimió) y se devuelve `renumbered`.
   */
  async create(
    user: AuthUser,
    dto: CreateOrderDto,
    ctx: { deviceId?: string | null; offline?: boolean; db?: Tx } = {},
  ): Promise<OrderResult> {
    const run = async (tx: Tx): Promise<OrderResult> => {
      const id = dto.id ?? randomUUID();

      const existing = await tx.order.findUnique({ where: { id }, include: ORDER_INCLUDE });
      if (existing) return { order: existing };

      const { lines } = await buildLines(tx, dto.items);
      const totalUsd = orderTotalOf(lines);

      if (dto.customerId) await this.assertCustomer(tx, dto.customerId);

      const number = await this.company.allocateOrderNumber(tx);
      const renumbered =
        dto.number && dto.number !== number ? { from: dto.number, to: number } : undefined;

      const createdAt = clampClientTime(dto.createdAt).at;

      await tx.order.create({
        data: {
          id,
          number,
          clientNumber: renumbered ? dto.number : null,
          createdAt,
          customerId: dto.customerId ?? null,
          customerName: dto.customerName?.trim() || 'Consumidor final',
          userId: user.id,
          totalUsd,
          note: dto.note ?? null,
          status: 'pendiente',
          deviceId: ctx.deviceId ?? null,
          createdOffline: ctx.offline ?? false,
        },
      });
      await this.tombstones.clear('order', id, tx);

      await tx.orderItem.createMany({ data: orderItemRows(lines, id) });

      if (dto.deposit) {
        // En línea el abono adelantado no puede pasar del total del pedido
        // (`createOrder` del frontend lo valida así). Offline se fusiona igual y
        // el excedente sale como `overpaidUsd`.
        const { deposit } = await this.deposits.create(tx, id, dto.deposit, {
          userId: user.id,
          deviceId: ctx.deviceId,
          enforceBalance: false,
        });
        if (!ctx.offline && dec(deposit.usdEquivalent).gt(totalUsd.plus(EPS))) {
          throw invalid(
            `El abono ($${dec(deposit.usdEquivalent).toFixed(2)}) supera el total del pedido ($${totalUsd.toFixed(2)})`,
          );
        }
      }

      return { order: await this.aggregate(id, tx), renumbered };
    };

    const result = ctx.db ? await run(ctx.db) : await this.prisma.$transaction(run);

    await this.audit.log(user, 'pedido_creado', 'order', result.order.id, {
      number: result.order.number,
      totalUsd: result.order.totalUsd.toString(),
      ...(result.renumbered ? { renumbered: result.renumbered } : {}),
    });
    return result;
  }

  /**
   * Edita el pedido con **bloqueo optimista** sobre `rev` (§5).
   *
   *  · `baseRev` desfasado ⇒ `conflict` con el estado del servidor: el cliente
   *    rebasa y reenvía con un `mutationId` nuevo.
   *  · pedido `procesado` o `cancelado` ⇒ `terminal_state`, rechazo permanente:
   *    el cliente descarta su mutación y adopta el servidor.
   *  · las líneas se reemplazan en bloque y el servidor **recalcula** `totalUsd`.
   *  · los abonos no se tocan: si el pedido baja por debajo de lo abonado, el
   *    excedente sale como `overpaidUsd`, no como saldo negativo.
   */
  async update(
    user: AuthUser,
    id: string,
    dto: UpdateOrderDto,
    ctx: { baseRev?: number | null; db?: Tx; offline?: boolean } = {},
  ): Promise<OrderResult> {
    const run = async (tx: Tx): Promise<OrderResult> => {
      const current = await tx.order.findUnique({ where: { id } });
      if (!current) throw notFound('El pedido');

      if (isTerminal(current.status as OrderStatusName)) {
        throw new AppError(
          'terminal_state',
          `El pedido está ${current.status} y ya no se puede editar`,
          { serverEntity: orderOut(await this.aggregate(id, tx)) },
        );
      }

      const baseRev = ctx.baseRev ?? dto.baseRev ?? null;
      if (baseRev !== null && current.rev !== baseRev) {
        throw new AppError('conflict', 'El pedido cambió en otro dispositivo', {
          serverEntity: orderOut(await this.aggregate(id, tx)),
        });
      }

      const data: Prisma.OrderUpdateInput = {};
      let statusIgnored: OrderResult['statusIgnored'];

      if (dto.customerId !== undefined) {
        if (dto.customerId) await this.assertCustomer(tx, dto.customerId);
        data.customer = dto.customerId ? { connect: { id: dto.customerId } } : { disconnect: true };
      }
      if (dto.customerName !== undefined) {
        data.customerName = dto.customerName.trim() || 'Consumidor final';
      }
      if (dto.note !== undefined) data.note = dto.note || null;

      if (dto.status !== undefined && dto.status !== current.status) {
        const transition = this.planStatus(current.status, dto.status, dto.cancelReason);
        if (transition.ignored) {
          statusIgnored = { requested: dto.status, current: current.status };
        } else {
          Object.assign(data, transition.data);
        }
      }

      if (dto.items) {
        const { lines } = await buildLines(tx, dto.items);
        // Reemplazo en bloque: las listas no se fusionan solas (§5, principio 3).
        await tx.orderItem.deleteMany({ where: { orderId: id } });
        await tx.orderItem.createMany({ data: orderItemRows(lines, id) });
        data.totalUsd = orderTotalOf(lines);
      }

      if (Object.keys(data).length) await tx.order.update({ where: { id }, data });

      // Relectura obligatoria: `order_items_bump_parent` ya movió el `rev` (§4.3).
      return { order: await this.aggregate(id, tx), statusIgnored };
    };

    const result = ctx.db ? await run(ctx.db) : await this.prisma.$transaction(run);

    if (result.statusIgnored) {
      // Una transición que retrocede se audita, no se aplica: queda el rastro de
      // que un dispositivo llegó tarde con un estado viejo.
      await this.audit.log(user, 'pedido_estado_ignorado', 'order', id, result.statusIgnored);
    }
    await this.audit.log(user, 'pedido_editado', 'order', id, {
      fields: Object.keys(dto).filter((k) => k !== 'baseRev'),
    });
    return result;
  }

  /** `POST /orders/:id/status` — sólo hacia adelante. */
  async setStatus(
    user: AuthUser,
    id: string,
    dto: SetOrderStatusDto,
    ctx: { baseRev?: number | null; db?: Tx } = {},
  ): Promise<OrderResult> {
    return this.update(
      user,
      id,
      { status: dto.status, cancelReason: dto.reason },
      { baseRev: ctx.baseRev ?? dto.baseRev ?? null, db: ctx.db },
    );
  }

  /**
   * Decide qué hacer con una transición de estado.
   *
   * `procesado` NO se puede pedir directamente: ese estado lo produce la creación
   * de la venta que factura el pedido, y el CHECK `orders_processed_needs_sale_ck`
   * exige que apunte a una venta. Pedirlo a mano dejaría un pedido "procesado" sin
   * comprobante.
   */
  private planStatus(
    from: OrderStatus,
    to: OrderStatus,
    reason?: string,
  ): { ignored: boolean; data: Prisma.OrderUpdateInput } {
    if (to === 'procesado') {
      throw invalid(
        'Un pedido pasa a procesado facturándolo (POST /sales con orderId), no cambiando su estado',
      );
    }

    if (!advances(from as OrderStatusName, to as OrderStatusName)) {
      return { ignored: true, data: {} };
    }

    if (to === 'cancelado') {
      return {
        ignored: false,
        data: {
          status: to,
          // El CHECK `orders_canceled_needs_date_ck` exige la fecha.
          canceledAt: new Date(),
          cancelReason: reason?.slice(0, 300) ?? 'Cancelado',
        },
      };
    }

    return { ignored: false, data: { status: to } };
  }

  /**
   * `DELETE /orders/:id`. Se niega si tiene abonos vigentes: borrarlo destruiría
   * el registro de un dinero que ya entró a caja. En ese caso hay que anular el
   * abono (devolución) o cancelar el pedido, que sí conserva el rastro
   * (`lib/business.deleteOrder`).
   */
  async remove(user: AuthUser, id: string, ctx: { db?: Tx } = {}): Promise<void> {
    const run = async (tx: Tx) => {
      const order = await tx.order.findUnique({ where: { id }, include: { deposits: true } });
      if (!order) throw notFound('El pedido');

      const balance = orderBalance(dec(order.totalUsd), order.deposits);
      // Misma tolerancia que `deleteOrder` del frontend: por debajo de un décimo
      // de céntimo no hay dinero real que preservar.
      if (balance.depositUsd.gt(new Dec('0.001'))) {
        throw new AppError(
          'has_deposits',
          `El pedido tiene $${balance.depositUsd.toFixed(2)} abonados. Anula el abono o cancela el pedido en lugar de eliminarlo.`,
          { depositUsd: balance.depositUsd.toNumber() },
        );
      }

      if (order.status === 'procesado') {
        throw new AppError('terminal_state', 'Un pedido facturado no se borra');
      }

      // Un pedido con abonos ANULADOS tampoco se borra, y esto es más estricto que
      // el frontend a propósito. `order_deposits.order_id` es RESTRICT, así que
      // borrar el pedido exigiría borrar esos abonos, y un abono anulado es el
      // rastro de que entró dinero y se devolvió. Destruirlo deja la caja de ese
      // día sin explicación. Cancelar el pedido consigue lo mismo y **conserva el
      // rastro**, que es lo que pide el §5 ("ante la duda, se conserva el asiento").
      if (order.deposits.length) {
        throw new AppError(
          'has_deposits',
          'El pedido tiene abonos anulados en su historial: cancélalo en lugar de eliminarlo, así el rastro del dinero devuelto no se pierde',
          { deposits: order.deposits.length },
        );
      }

      await tx.order.delete({ where: { id } });
      await this.tombstones.record('order', id, user.id, tx);
    };

    if (ctx.db) await run(ctx.db);
    else await this.prisma.$transaction(run);

    await this.audit.log(user, 'pedido_eliminado', 'order', id);
  }

  /** Pedidos con saldo pendiente, más antiguos primero (`ordersWithBalance`). */
  async withPendingBalance() {
    const rows = await this.prisma.order.findMany({
      where: { status: { notIn: ['cancelado', 'procesado'] } },
      include: ORDER_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });

    return rows
      .map((order) => ({ order, balance: orderBalance(dec(order.totalUsd), order.deposits) }))
      .filter((x) => x.balance.depositUsd.gt(EPS) && x.balance.balanceUsd.gt(EPS))
      .map((x) => this.withBalance(x.order));
  }

  /** Los abonos de un pedido, como entidad propia (tienen `rev` aparte). */
  async depositsOf(orderId: string) {
    const rows = await this.prisma.orderDeposit.findMany({
      where: { orderId },
      orderBy: { at: 'asc' },
    });
    return rows.map(depositOut);
  }

  private async assertCustomer(tx: Tx, id: string): Promise<void> {
    const row = await tx.customer.findUnique({ where: { id }, select: { id: true } });
    if (!row) throw invalid(`El cliente ${id} no existe`);
  }

  /** Recalcula `totalUsd` desde las líneas. Nunca se acepta del cliente. */
  async recalcTotal(tx: Tx, orderId: string): Promise<void> {
    const items = await tx.orderItem.findMany({
      where: { orderId },
      select: { subtotalUsd: true },
    });
    const total = usdScale(
      items.reduce((acc, i) => acc.plus(dec(i.subtotalUsd)), zero()),
      'totalUsd',
    );
    await tx.order.update({ where: { id: orderId }, data: { totalUsd: total } });
  }
}
