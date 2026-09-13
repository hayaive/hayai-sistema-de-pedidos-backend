import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { OrderDeposit } from '../generated/prisma/client';
import { AppError, invalid, notFound } from '../common/errors';
import { bs as bsScale, Dec, dec, EPS, rateOf, usd as usdScale } from '../common/money';
import { clampClientTime } from '../common/time';
import { Tx } from '../common/tx';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.types';
import { RatesService } from '../rates/rates.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateDepositDto } from './dto/order.dto';
import { orderBalance } from './order-balance';

export interface DepositContext {
  /** Usuario al que se le atribuye el abono. */
  userId: string;
  deviceId?: string | null;
  /**
   * `false` para una mutación de la cola offline: el dinero YA entró, así que no
   * se valida contra el saldo. En línea sí se valida (§5).
   */
  enforceBalance: boolean;
}

/**
 * Abonos sobre pedidos (ARCHITECTURE.md §5).
 *
 * Es la única entidad que se **fusiona siempre**: append-only e idempotente por
 * PK, de modo que dos cajas que abonaron sin verse conservan los dos abonos. Si
 * la suma pasa del total NO se rechaza: el excedente aparece como `overpaidUsd`,
 * un caso que el frontend ya modela.
 *
 * Cada abono congela la tasa del momento (`rateUsed`) porque el dinero entró a
 * esa tasa. El saldo, en cambio, se cotiza siempre a la tasa vigente: es dinero
 * que aún no se ha cobrado.
 */
@Injectable()
export class DepositsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rates: RatesService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Construye y asienta el abono. Réplica de `lib/orders.buildDeposit` +
   * `addOrderDeposit`, con la diferencia de que la validación contra el saldo es
   * opcional (ver `DepositContext.enforceBalance`).
   */
  async create(
    tx: Tx,
    orderId: string,
    dto: CreateDepositDto,
    ctx: DepositContext,
  ): Promise<{ deposit: OrderDeposit; duplicate: boolean }> {
    const id = dto.id ?? randomUUID();

    // Idempotente por PK: reenviar la mutación no duplica el cobro.
    const existing = await tx.orderDeposit.findUnique({ where: { id } });
    if (existing) return { deposit: existing, duplicate: true };

    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { deposits: true },
    });
    if (!order) throw notFound('El pedido');

    // Un pedido ya facturado se cobra sobre la venta, no con un abono nuevo; uno
    // cancelado no admite dinero. Igual que `addOrderDeposit` del frontend.
    if (order.status === 'procesado') {
      throw new AppError(
        'terminal_state',
        'El pedido ya fue procesado: el cobro va sobre la venta',
      );
    }
    if (order.status === 'cancelado') {
      throw new AppError('terminal_state', 'El pedido está cancelado');
    }

    const method = await tx.paymentMethod.findUnique({ where: { id: dto.methodId } });
    if (!method) throw invalid('Forma de pago inválida');
    if (!method.active) throw invalid(`"${method.name}" está desactivada`);
    if (method.requiresReference && !dto.reference?.trim()) {
      throw invalid(`"${method.name}" requiere número de referencia`);
    }

    // La tasa se congela: la del abono si viene (abono offline), si no la vigente.
    const rate = dto.rateUsed !== undefined ? rateOf(dto.rateUsed, 'rateUsed') : await this.rates.bcvRate(tx);
    if (method.currency === 'BS' && rate.lte(0)) {
      throw invalid('No hay tasa BCV cargada: no se puede abonar en bolívares');
    }

    const amount = bsScale(dto.amount, 'amount');
    if (amount.lte(0)) throw invalid('El monto del abono debe ser mayor que cero');

    // USD → tal cual; Bs → a 4 decimales, igual que `buildDeposit`.
    const usdEquivalent =
      method.currency === 'USD' ? usdScale(amount, 'usdEquivalent') : usdScale(amount.div(rate), 'usdEquivalent');
    if (usdEquivalent.lte(0)) {
      throw invalid('El abono no llega a un céntimo en USD: revisa el monto o la tasa');
    }

    if (ctx.enforceBalance) {
      const balance = orderBalance(dec(order.totalUsd), order.deposits);
      if (usdEquivalent.gt(balance.balanceUsd.plus(EPS))) {
        throw invalid(
          `El abono ($${usdEquivalent.toFixed(2)}) supera el saldo pendiente ($${balance.balanceUsd.toFixed(2)})`,
        );
      }
    }

    const at = clampClientTime(dto.at).at;

    const deposit = await tx.orderDeposit.create({
      data: {
        id,
        orderId,
        methodId: method.id,
        methodName: method.name,
        currency: method.currency,
        amount,
        usdEquivalent,
        // La tasa es NOT NULL con CHECK > 0: en un abono en USD se guarda la
        // vigente igualmente, que es lo que hace `buildDeposit`.
        rateUsed: rate.gt(0) ? rate : rateOf(1, 'rateUsed'),
        reference: dto.reference?.trim() || null,
        note: dto.note?.trim() || null,
        at,
        userId: ctx.userId,
        deviceId: ctx.deviceId ?? null,
      },
    });

    return { deposit, duplicate: false };
  }

  /**
   * Anula un abono (devolución o error de registro). No se borra: se marca, para
   * que el rastro quede. Es **idempotente y gana sobre no anular** (§5): si dos
   * dispositivos discrepan, la anulación es la que sobrevive.
   */
  async void(
    tx: Tx,
    depositId: string,
    reason: string,
    ctx: { userId: string },
  ): Promise<{ deposit: OrderDeposit; alreadyVoided: boolean }> {
    const deposit = await tx.orderDeposit.findUnique({ where: { id: depositId } });
    if (!deposit) throw notFound('El abono');

    if (deposit.voided) return { deposit, alreadyVoided: true };

    const order = await tx.order.findUnique({ where: { id: deposit.orderId } });
    if (order?.status === 'procesado') {
      throw new AppError(
        'terminal_state',
        'El pedido ya fue procesado: anula la venta en su lugar',
      );
    }

    const updated = await tx.orderDeposit.update({
      where: { id: depositId },
      data: {
        voided: true,
        voidedAt: new Date(),
        voidReason: reason.slice(0, 300),
        voidedByUserId: ctx.userId,
      },
    });

    return { deposit: updated, alreadyVoided: false };
  }

  /** `POST /orders/:id/deposits` (en línea: sí se valida contra el saldo). */
  async createOnline(user: AuthUser, orderId: string, dto: CreateDepositDto, deviceId?: string) {
    const { deposit } = await this.prisma.$transaction((tx) =>
      this.create(tx, orderId, dto, {
        userId: user.id,
        deviceId,
        enforceBalance: true,
      }),
    );

    await this.audit.log(user, 'abono_registrado', 'order', orderId, {
      depositId: deposit.id,
      amount: deposit.amount.toString(),
      currency: deposit.currency,
      usd: deposit.usdEquivalent.toString(),
    });

    return deposit;
  }

  async voidOnline(user: AuthUser, orderId: string, depositId: string, reason: string) {
    const { deposit } = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.orderDeposit.findUnique({ where: { id: depositId } });
      if (!existing || existing.orderId !== orderId) throw notFound('El abono de ese pedido');
      return this.void(tx, depositId, reason, { userId: user.id });
    });

    await this.audit.log(user, 'abono_anulado', 'order', orderId, {
      depositId,
      reason,
      usd: deposit.usdEquivalent.toString(),
    });

    return deposit;
  }

  /**
   * Convierte los abonos vigentes en pagos de la venta, conservando fecha y tasa
   * originales (`lib/orders.depositsAsPayments`). Así el abono nunca se pierde y
   * el cierre de caja lo cuenta el día en que realmente entró.
   */
  depositsAsPayments(deposits: OrderDeposit[]) {
    return deposits
      .filter((d) => !d.voided)
      .map((d) => ({
        methodId: d.methodId,
        methodName: d.methodName,
        currency: d.currency,
        amount: dec(d.amount),
        usdEquivalent: dec(d.usdEquivalent),
        reference: d.reference,
        at: d.at,
        rateUsed: dec(d.rateUsed) as Dec | null,
        fromOrderDepositId: d.id,
      }));
  }
}
