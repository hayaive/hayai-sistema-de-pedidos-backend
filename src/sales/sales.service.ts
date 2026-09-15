import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../generated/prisma/client';
import { AppError, invalid, notFound } from '../common/errors';
import { SALE_INCLUDE } from '../common/includes';
import { buildLines, saleItemRows, totalsOf } from '../common/lines';
import { PaymentDto } from '../common/dto/line-item.dto';
import { Dec, dec, EPS, rateOf, usd as usdScale, bs as bsScale, zero } from '../common/money';
import { saleOut } from '../common/serialize';
import { businessDateToUtc, clampClientTime, isBusinessDate } from '../common/time';
import { Tx } from '../common/tx';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.types';
import { CompanyService } from '../company/company.service';
import { InventoryService } from '../inventory/inventory.service';
import { DepositsService } from '../orders/deposits.service';
import { PrismaService } from '../prisma/prisma.service';
import { RatesService } from '../rates/rates.service';
import { CreateSaleDto, SalesQueryDto } from './dto/sale.dto';

export type SaleAggregate = Prisma.SaleGetPayload<{ include: typeof SALE_INCLUDE }>;

export interface SaleResult {
  sale: SaleAggregate;
  duplicate?: boolean;
  renumbered?: { from: string; to: string };
}

/** Motivos de movimiento de inventario. Se usan para detectar reasientos. */
const REASON_SALE = 'Salida por venta';
const REASON_VOID = 'Anulación de venta';

/**
 * Ventas (ARCHITECTURE.md §5).
 *
 * Insert-only: lo único que cambia después del alta es el paso a `anulada`. No hay
 * ruta de edición porque **lo facturado no se edita**, nunca.
 *
 * El alta hace cuatro cosas en una sola transacción, y las cuatro tienen que
 * pasar o ninguna: asentar el comprobante, mover el inventario, consumir los
 * abonos del pedido y asignar el número definitivo.
 */
@Injectable()
export class SalesService {
  private readonly log = new Logger(SalesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly company: CompanyService,
    private readonly rates: RatesService,
    private readonly inventory: InventoryService,
    private readonly deposits: DepositsService,
    private readonly audit: AuditService,
  ) {}

  async aggregate(id: string, db: Tx | PrismaService = this.prisma): Promise<SaleAggregate> {
    const row = await db.sale.findUnique({ where: { id }, include: SALE_INCLUDE });
    if (!row) throw notFound('La venta');
    return row;
  }

  async list(query: SalesQueryDto) {
    for (const day of [query.from, query.to]) {
      if (day && !isBusinessDate(day)) throw invalid('from/to tienen que ser YYYY-MM-DD');
    }

    const where: Prisma.SaleWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      // Se filtra por día contable: `createdAt::date` en UTC manda las ventas de
      // después de las 20:00 en Caracas al día siguiente (§3.4).
      ...(query.from || query.to
        ? {
            businessDate: {
              ...(query.from ? { gte: businessDateToUtc(query.from) } : {}),
              ...(query.to ? { lte: businessDateToUtc(query.to) } : {}),
            },
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.sale.count({ where }),
      this.prisma.sale.findMany({
        where,
        include: SALE_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return { page: query.page, pageSize: query.pageSize, total, items: rows.map(saleOut) };
  }

  async getOne(id: string) {
    return saleOut(await this.aggregate(id));
  }

  /**
   * Registra la venta.
   *
   * Reglas que aplica, en orden:
   *  1. **PK repetida ⇒ `duplicate`**, no error: es un reenvío (§3.1).
   *  2. **Pedido ya facturado ⇒ rechazo permanente** `order_already_billed`,
   *     devolviendo la venta existente. El índice único parcial
   *     `sales_active_order_uq` es la red de seguridad en la base.
   *  3. El número lo asigna el servidor; si el cliente traía otro, va a
   *     `clientNumber` y se devuelve `renumbered`.
   *  4. Los abonos vigentes del pedido entran como pagos con su fecha y tasa
   *     originales, de modo que el cierre los cuenta el día en que entraron.
   *  5. Los pagos tienen que cubrir el total (con tolerancia de céntimos).
   *  6. Sin tasa BCV vigente no se vende en línea. Ver `assertSaleRate`.
   *  7. Cada línea que no sea combo descuenta inventario en la misma transacción.
   */
  async create(
    user: AuthUser,
    dto: CreateSaleDto,
    ctx: { deviceId?: string | null; offline?: boolean; db?: Tx } = {},
  ): Promise<SaleResult> {
    const offline = ctx.offline ?? dto.createdOffline ?? false;

    const run = async (tx: Tx): Promise<SaleResult> => {
      const id = dto.id ?? randomUUID();

      const existing = await tx.sale.findUnique({ where: { id }, include: SALE_INCLUDE });
      if (existing) return { sale: existing, duplicate: true };

      // ── 1 · Pedido: un pedido no se factura dos veces ──────────────────────
      let order = null;
      if (dto.orderId) {
        order = await tx.order.findUnique({
          where: { id: dto.orderId },
          include: { deposits: true },
        });
        if (!order) throw invalid(`El pedido ${dto.orderId} no existe`);

        const billed = await tx.sale.findFirst({
          where: { orderId: dto.orderId, status: 'completada' },
          include: SALE_INCLUDE,
        });
        if (billed) {
          throw new AppError(
            'order_already_billed',
            `El pedido ${order.number} ya fue facturado con ${billed.number}`,
            { serverEntity: saleOut(billed) },
          );
        }
        if (order.status === 'cancelado') {
          throw new AppError('terminal_state', 'El pedido está cancelado: no se puede facturar');
        }
      }

      if (dto.customerId) {
        const customer = await tx.customer.findUnique({ where: { id: dto.customerId } });
        if (!customer) throw invalid(`El cliente ${dto.customerId} no existe`);
      }

      // ── 2 · Líneas, tasa congelada y totales ───────────────────────────────
      const { lines, products } = await buildLines(tx, dto.items);

      const snapshot = await this.resolveSnapshot(tx, dto);
      const { totalUsd, totalBs } = totalsOf(lines, snapshot.usd);

      // ── 3 · Tasa BCV ───────────────────────────────────────────────────────
      await this.assertSaleRate(tx, id, snapshot.usd, { offline, user });

      // ── 4 · Pagos: los abonos del pedido primero ───────────────────────────
      // Los abonos los inyecta SIEMPRE el servidor, nunca el cliente: es la única
      // forma de garantizar que cada abono se consuma una sola vez (el índice
      // único de `from_order_deposit_id` es la red de seguridad). El DTO de pago
      // no declara `fromOrderDepositId` justamente por eso.
      const depositPayments = order ? this.deposits.depositsAsPayments(order.deposits) : [];
      const clientPayments = await this.buildPayments(tx, dto.payments ?? [], snapshot, dto.createdAt);

      const payments = [
        ...depositPayments.map((p) => ({
            methodId: p.methodId,
            methodName: p.methodName,
            currency: p.currency,
            amount: p.amount,
            usdEquivalent: p.usdEquivalent,
            reference: p.reference,
            at: p.at,
            rateUsed: p.rateUsed,
            fromOrderDepositId: p.fromOrderDepositId as string | null,
          })),
        ...clientPayments,
      ];

      const paid = payments.reduce((acc, p) => acc.plus(p.usdEquivalent), zero());

      // Misma condición que `createSale` del frontend: se tolera un desfase de
      // céntimos, pero no que los pagos se queden cortos.
      if (paid.lt(totalUsd) && !paid.minus(totalUsd).abs().lte(EPS)) {
        throw invalid(
          `Los pagos ($${paid.toFixed(2)}) no cubren el total de la venta ($${totalUsd.toFixed(2)})`,
        );
      }

      const changeUsd =
        dto.changeUsd !== undefined
          ? usdScale(dto.changeUsd, 'changeUsd')
          : Dec.max(zero(), paid.minus(totalUsd).toDecimalPlaces(2, Dec.ROUND_HALF_UP));

      // ── 5 · Número definitivo ──────────────────────────────────────────────
      const number = await this.company.allocateSaleNumber(tx);
      const renumbered =
        dto.number && dto.number !== number ? { from: dto.number, to: number } : undefined;

      const createdAt = clampClientTime(dto.createdAt).at;

      // ── 6 · El comprobante ─────────────────────────────────────────────────
      await tx.sale.create({
        data: {
          id,
          number,
          clientNumber: renumbered ? dto.number : null,
          createdAt,
          customerId: dto.customerId ?? null,
          customerName: dto.customerName?.trim() || 'Consumidor final',
          userId: user.id,
          userName: user.fullName,
          totalUsd,
          totalBs,
          changeUsd,
          rateUsd: snapshot.usd,
          rateEur: snapshot.eur,
          rateBinance: snapshot.binance,
          rateAt: snapshot.at,
          status: 'completada',
          orderId: dto.orderId ?? null,
          note: dto.note ?? null,
          deviceId: ctx.deviceId ?? null,
          createdOffline: offline,
        },
      });

      await tx.saleItem.createMany({ data: saleItemRows(lines, id) });

      for (const [position, p] of payments.entries()) {
        await tx.salePayment.create({
          data: {
            id: randomUUID(),
            saleId: id,
            position,
            methodId: p.methodId,
            methodName: p.methodName,
            currency: p.currency,
            amount: p.amount,
            usdEquivalent: p.usdEquivalent,
            reference: p.reference ?? null,
            at: p.at,
            rateUsed: p.rateUsed ?? null,
            fromOrderDepositId: p.fromOrderDepositId ?? null,
          },
        });
      }

      // ── 7 · Inventario ─────────────────────────────────────────────────────
      // Los combos NO mueven stock: su contenido es descriptivo (`createSale` del
      // frontend hace lo mismo con `if (p && !p.isCombo)`).
      for (const line of lines) {
        const product = products.get(line.productId);
        if (!product || product.isCombo) continue;
        await this.inventory.apply(tx, {
          productId: line.productId,
          type: 'salida',
          qty: line.qty,
          reason: REASON_SALE,
          note: number,
          userId: user.id,
          saleId: id,
          deviceId: ctx.deviceId ?? null,
          at: createdAt,
        });
      }

      // ── 8 · Cerrar el pedido ───────────────────────────────────────────────
      if (order) {
        await tx.order.update({
          where: { id: order.id },
          data: { status: 'procesado', saleId: id },
        });
        // Los abonos quedan marcados como consumidos por esta venta
        // (`linkDepositsToSale`).
        await tx.orderDeposit.updateMany({
          where: { orderId: order.id, voided: false },
          data: { saleId: id },
        });
      }

      return { sale: await this.aggregate(id, tx), renumbered };
    };

    const result = ctx.db ? await run(ctx.db) : await this.prisma.$transaction(run, { timeout: 20_000 });

    if (!result.duplicate) {
      await this.audit.log(user, 'venta_creada', 'sale', result.sale.id, {
        number: result.sale.number,
        totalUsd: result.sale.totalUsd.toString(),
        orderId: result.sale.orderId ?? undefined,
        ...(result.renumbered ? { renumbered: result.renumbered } : {}),
      });
    }
    return result;
  }

  /**
   * Anula la venta. **Idempotente**: anular dos veces devuelve la misma venta sin
   * volver a devolver stock.
   *
   * La única transición posible después del alta es `completada → anulada`; no se
   * revierte el estado del pedido que facturó, porque el índice único parcial
   * `sales_active_order_uq` ya libera el pedido para refacturarlo (§11, pendiente 3).
   */
  async void(
    user: AuthUser,
    id: string,
    reason: string,
    ctx: { deviceId?: string | null; db?: Tx } = {},
  ): Promise<{ sale: SaleAggregate; alreadyVoided: boolean }> {
    const run = async (tx: Tx) => {
      const sale = await tx.sale.findUnique({ where: { id }, include: SALE_INCLUDE });
      if (!sale) throw notFound('La venta');

      if (sale.status === 'anulada') {
        return { sale, alreadyVoided: true };
      }

      await tx.sale.update({
        where: { id },
        data: {
          status: 'anulada',
          // El CHECK `sales_voided_needs_date_ck` exige la fecha.
          voidedAt: new Date(),
          voidReason: reason.slice(0, 300),
          voidedByUserId: user.id,
        },
      });

      // Devolución de stock, idempotente: si ya hay asientos de devolución para
      // esta venta, no se repiten (la anulación puede llegar dos veces desde dos
      // dispositivos).
      const returned = await tx.inventoryMovement.count({
        where: { saleId: id, type: 'entrada', reason: REASON_VOID },
      });

      if (returned === 0) {
        const products = await tx.product.findMany({
          where: { id: { in: sale.items.map((i) => i.productId) } },
          select: { id: true, isCombo: true },
        });
        const isCombo = new Map(products.map((p) => [p.id, p.isCombo]));

        for (const item of sale.items) {
          if (isCombo.get(item.productId)) continue;
          await this.inventory.apply(tx, {
            productId: item.productId,
            type: 'entrada',
            qty: dec(item.qty),
            reason: REASON_VOID,
            note: sale.number,
            userId: user.id,
            saleId: id,
            deviceId: ctx.deviceId ?? null,
          });
        }
      }

      return { sale: await this.aggregate(id, tx), alreadyVoided: false };
    };

    const result = ctx.db ? await run(ctx.db) : await this.prisma.$transaction(run, { timeout: 20_000 });

    if (!result.alreadyVoided) {
      await this.audit.log(user, 'venta_anulada', 'sale', id, {
        reason,
        number: result.sale.number,
      });
    }
    return result;
  }

  // ── Auxiliares ─────────────────────────────────────────────────────────────

  /**
   * Tasa que se congela en el comprobante. La del cliente si viene (venta
   * offline: es la tasa a la que se cobró de verdad), si no la vigente.
   */
  private async resolveSnapshot(tx: Tx, dto: CreateSaleDto) {
    if (dto.rateSnapshot) {
      const at = clampClientTime(dto.rateSnapshot.at).at;
      return {
        usd: rateOf(dto.rateSnapshot.usd, 'rateSnapshot.usd'),
        eur: rateOf(dto.rateSnapshot.eur ?? 0, 'rateSnapshot.eur'),
        binance: rateOf(dto.rateSnapshot.binance ?? 0, 'rateSnapshot.binance'),
        at,
      };
    }
    return this.rates.snapshot(tx);
  }

  /**
   * Normaliza los pagos declarados por el cliente.
   *
   * `currency` sale del método de pago y `usdEquivalent` se calcula aquí: aceptar
   * el equivalente del cliente permitiría asentar un cobro en Bs cuyo USD no
   * corresponde a la tasa que dice haber usado, y eso descuadra el cierre.
   */
  private async buildPayments(
    tx: Tx,
    declared: PaymentDto[],
    snapshot: { usd: Dec },
    saleCreatedAt?: string,
  ) {
    const out: {
      methodId: string;
      methodName: string;
      currency: 'USD' | 'BS';
      amount: Dec;
      usdEquivalent: Dec;
      reference: string | null;
      at: Date;
      rateUsed: Dec | null;
      fromOrderDepositId: string | null;
    }[] = [];

    for (const p of declared) {
      const method = await tx.paymentMethod.findUnique({ where: { id: p.methodId } });
      if (!method) throw invalid(`La forma de pago ${p.methodId} no existe`);
      if (!method.active) throw invalid(`"${method.name}" está desactivada`);
      if (method.requiresReference && !p.reference?.trim()) {
        throw invalid(`"${method.name}" requiere número de referencia`);
      }

      const amount = bsScale(p.amount, 'amount');
      if (amount.lte(0)) throw invalid('El monto de un pago tiene que ser mayor que cero');

      const rate = p.rateUsed !== undefined ? rateOf(p.rateUsed, 'rateUsed') : snapshot.usd;
      if (method.currency === 'BS' && rate.lte(0)) {
        // El CHECK `sale_payments_bs_needs_rate_ck` lo exige: un cobro en Bs sin
        // la tasa con la que se calculó no es auditable.
        throw invalid('No hay tasa BCV: no se puede cobrar en bolívares');
      }

      const usdEquivalent =
        method.currency === 'USD'
          ? usdScale(amount, 'usdEquivalent')
          : usdScale(amount.div(rate), 'usdEquivalent');

      out.push({
        methodId: method.id,
        methodName: method.name,
        currency: method.currency,
        amount,
        usdEquivalent,
        reference: p.reference?.trim() || null,
        // `at` es el momento en que entró ESE dinero; si falta, el de la venta.
        at: clampClientTime(p.at ?? saleCreatedAt).at,
        rateUsed: method.currency === 'BS' ? rate : rate.gt(0) ? rate : null,
        fromOrderDepositId: null,
      });
    }

    return out;
  }

  /**
   * Una venta sin tasa BCV vigente no se puede asentar en línea.
   *
   * Sustituye al viejo bloqueo por banda de precio (retirado en 2026-09). Ese
   * bloqueo decía "el precio queda fuera del rango permitido", pero el algoritmo
   * corregía el importe en Bs hacia dentro de la banda antes de validar: en la
   * práctica sólo fallaba **cuando no había tasa**, con un mensaje que no
   * explicaba el problema real. Éste sí lo explica.
   *
   * Sin tasa, `rateUsd` se asienta en 0 y el total en Bs del comprobante sale 0:
   * el cierre del día deja de cuadrar y el ticket no se puede reimprimir con la
   * tasa real. Por eso se bloquea antes de escribir nada.
   *
   * Misma política que tenía la banda, y por la misma razón del §5: una venta que
   * llega de la **cola offline no se bloquea**, se audita. Ese dinero ya entró y
   * rechazarla sería perderla del registro. Los cobros en Bs siguen teniendo su
   * propia validación por pago en `buildPayments`, que sí es innegociable porque
   * sin tasa no hay equivalente en USD que asentar.
   */
  private async assertSaleRate(
    tx: Tx,
    saleId: string,
    rate: Dec,
    ctx: { offline: boolean; user: AuthUser },
  ): Promise<void> {
    if (rate.gt(0)) return;

    const message = 'No se puede registrar la venta sin una tasa BCV vigente';
    if (!ctx.offline) throw invalid(message);

    this.log.warn(`Venta offline sin tasa BCV, se acepta y se audita: ${saleId}`);
    await this.audit.log(
      ctx.user,
      'venta_sin_tasa',
      'sale',
      saleId,
      { rateUsd: rate.toNumber() },
      { tx },
    );
  }
}
