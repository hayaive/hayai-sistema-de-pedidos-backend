import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppError, notFound } from '../common/errors';
import { slug } from '../common/ids';
import { paymentMethodOut } from '../common/serialize';
import { AuthUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { Tx } from '../common/tx';
import { TombstonesService } from '../sync/tombstones.service';
import { CreatePaymentMethodDto, UpdatePaymentMethodDto } from './dto/payment-method.dto';

@Injectable()
export class PaymentMethodsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tombstones: TombstonesService,
  ) {}

  async list() {
    const rows = await this.prisma.paymentMethod.findMany({
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
    });
    return rows.map(paymentMethodOut);
  }

  async create(user: AuthUser, dto: CreatePaymentMethodDto) {
    const base = slug(dto.name);
    const id = dto.id ?? (base ? `pm-${base}` : randomUUID());

    const row = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.paymentMethod.findUnique({ where: { id } });
      if (existing) return existing;

      await this.assertNameFree(tx, dto.name, id);

      const created = await tx.paymentMethod.create({
        data: {
          id,
          name: dto.name.trim(),
          currency: dto.currency,
          requiresReference: dto.requiresReference ?? false,
          active: dto.active ?? true,
          position: dto.position ?? 0,
        },
      });
      await this.tombstones.clear('payment_method', id, tx);
      return created;
    });

    await this.audit.log(user, 'forma_pago_creada', 'payment_method', row.id, { name: row.name });
    return paymentMethodOut(row);
  }

  async update(user: AuthUser, id: string, dto: UpdatePaymentMethodDto) {
    const row = await this.prisma.$transaction(async (tx) => {
      const current = await tx.paymentMethod.findUnique({ where: { id } });
      if (!current) throw notFound('La forma de pago');

      if (dto.name !== undefined) await this.assertNameFree(tx, dto.name, id);

      // Cambiar la moneda de una forma de pago con movimientos rompería el
      // historial: un comprobante viejo quedaría cobrado "en" una moneda que la
      // forma de pago ya no tiene.
      if (dto.currency !== undefined && dto.currency !== current.currency) {
        const counts = await this.historyCounts(tx, id);
        if (counts.salePayments || counts.orderDeposits || counts.closureLines) {
          throw new AppError(
            'has_history',
            'No se puede cambiar la moneda de una forma de pago con movimientos: crea otra',
            counts,
          );
        }
      }

      return tx.paymentMethod.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.currency !== undefined ? { currency: dto.currency } : {}),
          ...(dto.requiresReference !== undefined ? { requiresReference: dto.requiresReference } : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
          ...(dto.position !== undefined ? { position: dto.position } : {}),
        },
      });
    });

    await this.audit.log(user, 'forma_pago_editada', 'payment_method', id, {
      fields: Object.keys(dto),
    });
    return paymentMethodOut(row);
  }

  /**
   * Sólo si nadie la referencia. `sale_payments.method_id`,
   * `order_deposits.method_id` y `closure_methods.method_id` son RESTRICT: un
   * comprobante o un cierre viejo tienen que seguir sabiendo con qué se cobró.
   */
  async remove(user: AuthUser, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.paymentMethod.findUnique({ where: { id } });
      if (!current) throw notFound('La forma de pago');

      const counts = await this.historyCounts(tx, id);
      if (counts.salePayments || counts.orderDeposits || counts.closureLines) {
        throw new AppError(
          'has_history',
          'La forma de pago está en uso: desactívala en vez de eliminarla',
          counts,
        );
      }

      await tx.paymentMethod.delete({ where: { id } });
      await this.tombstones.record('payment_method', id, user.id, tx);
    });
    await this.audit.log(user, 'forma_pago_eliminada', 'payment_method', id);
  }

  private async assertNameFree(tx: Tx, name: string, exceptId: string): Promise<void> {
    const clash = await tx.paymentMethod.findFirst({
      where: { name: name.trim(), id: { not: exceptId } },
    });
    if (clash) {
      throw new AppError('conflict', 'Ya existe una forma de pago con ese nombre');
    }
  }

  private async historyCounts(tx: Tx, id: string) {
    const [salePayments, orderDeposits, closureLines] = await Promise.all([
      tx.salePayment.count({ where: { methodId: id } }),
      tx.orderDeposit.count({ where: { methodId: id } }),
      tx.closureMethod.count({ where: { methodId: id } }),
    ]);
    return { salePayments, orderDeposits, closureLines };
  }
}
