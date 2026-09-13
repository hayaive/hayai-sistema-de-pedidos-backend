import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppError, notFound } from '../common/errors';
import { slug } from '../common/ids';
import { priceTypeOut } from '../common/serialize';
import { Tx } from '../common/tx';
import { AuthUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { TombstonesService } from '../sync/tombstones.service';
import { CreatePriceTypeDto, UpdatePriceTypeDto } from './dto/catalog.dto';

@Injectable()
export class PriceTypesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tombstones: TombstonesService,
  ) {}

  async list() {
    const rows = await this.prisma.priceType.findMany({
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
    });
    return rows.map(priceTypeOut);
  }

  async create(user: AuthUser, dto: CreatePriceTypeDto) {
    const base = slug(dto.name);
    const id = dto.id ?? (base ? `pt-${base}` : randomUUID());

    const row = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.priceType.findUnique({ where: { id } });
      if (existing) return existing;

      if (dto.isDefault) await this.clearDefault(tx, id);
      const created = await tx.priceType.create({
        data: {
          id,
          name: dto.name.trim(),
          isDefault: dto.isDefault ?? false,
          position: dto.position ?? 0,
        },
      });
      await this.tombstones.clear('price_type', id, tx);
      return created;
    });

    await this.audit.log(user, 'tipo_precio_creado', 'price_type', row.id, { name: row.name });
    return priceTypeOut(row);
  }

  async update(user: AuthUser, id: string, dto: UpdatePriceTypeDto) {
    const row = await this.prisma.$transaction(async (tx) => {
      const current = await tx.priceType.findUnique({ where: { id } });
      if (!current) throw notFound('El tipo de precio');

      // El índice único parcial `price_types_single_default_uq` sólo admite un
      // default: hay que quitárselo al anterior ANTES de ponerlo aquí, o el
      // UPDATE choca contra el índice.
      if (dto.isDefault === true) await this.clearDefault(tx, id);
      if (dto.isDefault === false && current.isDefault) {
        const others = await tx.priceType.count({ where: { id: { not: id } } });
        if (others === 0) {
          throw new AppError(
            'validation_failed',
            'Tiene que quedar un tipo de precio por defecto: márcalo en otro primero',
          );
        }
      }

      return tx.priceType.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.isDefault !== undefined ? { isDefault: dto.isDefault } : {}),
          ...(dto.position !== undefined ? { position: dto.position } : {}),
        },
      });
    });

    await this.audit.log(user, 'tipo_precio_editado', 'price_type', id, {
      fields: Object.keys(dto),
    });
    return priceTypeOut(row);
  }

  /**
   * Sólo si nadie lo referencia. `sale_items.price_type_id` es RESTRICT: un
   * comprobante viejo tiene que seguir sabiendo con qué tipo de precio se cobró.
   */
  async remove(user: AuthUser, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.priceType.findUnique({ where: { id } });
      if (!current) throw notFound('El tipo de precio');

      const [saleItems, orderItems, productPrices, groupPrices] = await Promise.all([
        tx.saleItem.count({ where: { priceTypeId: id } }),
        tx.orderItem.count({ where: { priceTypeId: id } }),
        tx.productPrice.count({ where: { priceTypeId: id } }),
        tx.priceGroupPrice.count({ where: { priceTypeId: id } }),
      ]);
      if (saleItems || orderItems || productPrices || groupPrices) {
        throw new AppError('has_history', 'El tipo de precio está en uso', {
          saleItems,
          orderItems,
          productPrices,
          groupPrices,
        });
      }

      await tx.priceType.delete({ where: { id } });
      await this.tombstones.record('price_type', id, user.id, tx);
    });
    await this.audit.log(user, 'tipo_precio_eliminado', 'price_type', id);
  }

  private async clearDefault(tx: Tx, exceptId: string): Promise<void> {
    await tx.priceType.updateMany({
      where: { isDefault: true, id: { not: exceptId } },
      data: { isDefault: false },
    });
  }
}
