import { Injectable } from '@nestjs/common';
import { AppError, invalid } from '../../common/errors';
import { depositOut, movementOut, orderOut, saleOut } from '../../common/serialize';
import { parsePayload } from '../../common/validate-payload';
import { CreateMovementDto } from '../../inventory/dto/movement.dto';
import { InventoryService } from '../../inventory/inventory.service';
import { DepositsService } from '../../orders/deposits.service';
import { OrdersService } from '../../orders/orders.service';
import {
  CreateDepositDto,
  CreateOrderDto,
  SetOrderStatusDto,
  UpdateOrderDto,
} from '../../orders/dto/order.dto';
import { CreateSaleDto, VoidSaleDto } from '../../sales/dto/sale.dto';
import { SalesService } from '../../sales/sales.service';
import { HandlerOutcome, MutationContext, MutationHandler } from '../sync.types';

/**
 * Handlers de las mutaciones que llevan dinero: ventas, pedidos, abonos y
 * movimientos de inventario. Son los primeros que había que construir
 * (ARCHITECTURE.md §9, orden de trabajo) porque son los que no se pueden perder.
 *
 * Cada handler recibe la transacción de su mutación: **una mutación mala no
 * bloquea la cola** (§6.5), y todo lo que toca se deshace junto si falla.
 */
@Injectable()
export class MoneyHandlers {
  constructor(
    private readonly sales: SalesService,
    private readonly orders: OrdersService,
    private readonly deposits: DepositsService,
    private readonly inventory: InventoryService,
  ) {}

  handlers(): Record<string, MutationHandler> {
    return {
      'sale.create': (ctx) => this.saleCreate(ctx),
      'sale.void': (ctx) => this.saleVoid(ctx),
      'order.create': (ctx) => this.orderCreate(ctx),
      'order.update': (ctx) => this.orderUpdate(ctx),
      'order.status': (ctx) => this.orderStatus(ctx),
      'order.delete': (ctx) => this.orderDelete(ctx),
      'orderDeposit.create': (ctx) => this.depositCreate(ctx),
      'orderDeposit.void': (ctx) => this.depositVoid(ctx),
      'movement.create': (ctx) => this.movementCreate(ctx),
    };
  }

  /**
   * `sale.create`. Mueve inventario y consume los abonos del pedido.
   *
   * Una venta que llega de la cola **ya ocurrió**: se marca `offline` para que la
   * banda de precio avise en lugar de bloquear (ver `SalesService.assertPriceBands`)
   * y para que el ticket quede identificado como renumerable.
   */
  private async saleCreate(ctx: MutationContext): Promise<HandlerOutcome> {
    const dto = parsePayload(CreateSaleDto, { createdAt: ctx.clientAt.toISOString(), ...ctx.payload });

    const { sale, duplicate, renumbered } = await this.sales.create(ctx.user, dto, {
      deviceId: ctx.deviceId,
      offline: true,
      db: ctx.tx,
    });

    return {
      status: duplicate ? 'duplicate' : 'applied',
      entityId: sale.id,
      serverEntity: saleOut(sale),
      renumbered,
    };
  }

  /** `sale.void`. Idempotente: si ya estaba anulada, `duplicate`. */
  private async saleVoid(ctx: MutationContext): Promise<HandlerOutcome> {
    const id = requireId(ctx.payload, 'saleId');
    const dto = parsePayload(VoidSaleDto, {
      reason: ctx.payload.reason ?? ctx.payload.voidReason ?? 'Anulada sin motivo declarado',
    });

    const { sale, alreadyVoided } = await this.sales.void(ctx.user, id, dto.reason, {
      deviceId: ctx.deviceId,
      db: ctx.tx,
    });

    return {
      status: alreadyVoided ? 'duplicate' : 'applied',
      entityId: sale.id,
      serverEntity: saleOut(sale),
    };
  }

  /** `order.create`. Admite un abono adelantado en el mismo acto. */
  private async orderCreate(ctx: MutationContext): Promise<HandlerOutcome> {
    const dto = parsePayload(CreateOrderDto, {
      createdAt: ctx.clientAt.toISOString(),
      ...ctx.payload,
    });

    const { order, renumbered } = await this.orders.create(ctx.user, dto, {
      deviceId: ctx.deviceId,
      offline: true,
      db: ctx.tx,
    });

    return {
      status: 'applied',
      entityId: order.id,
      serverEntity: orderOut(order),
      renumbered,
    };
  }

  /**
   * `order.update`. Parche con `baseRev`; las líneas se reemplazan en bloque.
   *
   * Un `baseRev` desfasado sale como `conflict` con el estado del servidor: el
   * cliente rebasa y **reenvía con un `mutationId` nuevo** (§5). Un pedido en
   * estado terminal sale como `rejected`/`terminal_state`, que es permanente.
   */
  private async orderUpdate(ctx: MutationContext): Promise<HandlerOutcome> {
    const id = requireId(ctx.payload, 'orderId');
    const dto = parsePayload(UpdateOrderDto, omit(ctx.payload, ['orderId', 'id']));

    const { order, statusIgnored } = await this.orders.update(ctx.user, id, dto, {
      baseRev: ctx.baseRev ?? dto.baseRev ?? null,
      db: ctx.tx,
      offline: true,
    });

    return {
      status: 'applied',
      entityId: order.id,
      serverEntity: orderOut(order),
      reason: statusIgnored
        ? `transición ignorada: el servidor ya está en ${statusIgnored.current}`
        : undefined,
    };
  }

  /**
   * `order.status`. **Sólo hacia adelante**: una transición que retrocede se
   * ignora y se audita, y se responde `applied` con el estado del servidor para
   * que el cliente lo adopte y saque la mutación de la cola. Devolver `rejected`
   * haría que la UI avisara de un "error" que en realidad es el orden normal de
   * dos dispositivos empujando el mismo pedido.
   */
  private async orderStatus(ctx: MutationContext): Promise<HandlerOutcome> {
    const id = requireId(ctx.payload, 'orderId');
    const dto = parsePayload(SetOrderStatusDto, omit(ctx.payload, ['orderId', 'id']));

    const { order, statusIgnored } = await this.orders.setStatus(ctx.user, id, dto, {
      baseRev: ctx.baseRev ?? dto.baseRev ?? null,
      db: ctx.tx,
    });

    return {
      status: 'applied',
      entityId: order.id,
      serverEntity: orderOut(order),
      reason: statusIgnored
        ? `transición ignorada: el servidor ya está en ${statusIgnored.current}`
        : undefined,
    };
  }

  /** `order.delete`. Se niega si tiene abonos vigentes: es dinero que ya entró. */
  private async orderDelete(ctx: MutationContext): Promise<HandlerOutcome> {
    const id = requireId(ctx.payload, 'orderId');

    const existing = await ctx.tx.order.findUnique({ where: { id } });
    if (!existing) {
      // Ya no está: el borrado es idempotente y el cliente puede sacarlo de la cola.
      return { status: 'duplicate', entityId: id };
    }

    await this.orders.remove(ctx.user, id, { db: ctx.tx });
    return { status: 'applied', entityId: id };
  }

  /**
   * `orderDeposit.create`. **Siempre se fusiona** (§5): append-only e idempotente
   * por PK, sin validar contra el saldo, porque el dinero ya entró. Si la suma
   * pasa del total, el excedente aparece como `overpaidUsd`.
   */
  private async depositCreate(ctx: MutationContext): Promise<HandlerOutcome> {
    const orderId = requireId(ctx.payload, 'orderId');
    const dto = parsePayload(CreateDepositDto, {
      at: ctx.clientAt.toISOString(),
      ...omit(ctx.payload, ['orderId']),
    });

    const { deposit, duplicate } = await this.deposits.create(ctx.tx, orderId, dto, {
      userId: ctx.user.id,
      deviceId: ctx.deviceId,
      // Offline nunca se valida contra el saldo: ver §5, "siempre se fusionan".
      enforceBalance: false,
    });

    return {
      status: duplicate ? 'duplicate' : 'applied',
      entityId: deposit.id,
      serverEntity: depositOut(deposit),
    };
  }

  /** `orderDeposit.void`. Idempotente y gana sobre no anular. */
  private async depositVoid(ctx: MutationContext): Promise<HandlerOutcome> {
    const depositId = requireId(ctx.payload, 'depositId');
    const reason = String(ctx.payload.reason ?? ctx.payload.voidReason ?? 'Anulado');

    const { deposit, alreadyVoided } = await this.deposits.void(ctx.tx, depositId, reason, {
      userId: ctx.user.id,
    });

    return {
      status: alreadyVoided ? 'duplicate' : 'applied',
      entityId: deposit.id,
      serverEntity: depositOut(deposit),
    };
  }

  /**
   * `movement.create`. `entrada` y `salida` conmutan; el `ajuste` se resuelve **en
   * el momento de aplicar**, así que un ajuste creado offline a las 9:00 que llega
   * a las 18:00 no borra las ventas que ocurrieron entre medias.
   */
  private async movementCreate(ctx: MutationContext): Promise<HandlerOutcome> {
    const productId = requireId(ctx.payload, 'productId');
    const dto = parsePayload(CreateMovementDto, {
      createdAt: ctx.clientAt.toISOString(),
      ...omit(ctx.payload, ['productId']),
    });

    const existing = dto.id
      ? await ctx.tx.inventoryMovement.findUnique({ where: { id: dto.id } })
      : null;

    const movement = await this.inventory.apply(ctx.tx, {
      id: dto.id,
      productId,
      type: dto.type,
      qty: dto.qty,
      reason: dto.reason,
      note: dto.note,
      userId: ctx.user.id,
      deviceId: ctx.deviceId,
      at: ctx.clientAt,
    });

    return {
      status: existing ? 'duplicate' : 'applied',
      entityId: movement.id,
      serverEntity: movementOut(movement),
    };
  }
}

/** Lee un id obligatorio del payload con un mensaje útil si falta. */
export function requireId(payload: Record<string, unknown>, key: string): string {
  const value = payload[key] ?? payload.id;
  if (typeof value !== 'string' || !value.trim()) {
    throw invalid(`El payload necesita ${key}`);
  }
  return value;
}

export function omit(
  payload: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) if (!keys.includes(k)) out[k] = v;
  return out;
}

/** Rechazo permanente con código del contrato, para los handlers. */
export const rejectPermanent = (code: 'online_only' | 'terminal_state', message: string) =>
  new AppError(code, message);
