import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../generated/prisma/client';
import { AppError, invalid, notFound } from '../common/errors';
import { PRICE_GROUP_INCLUDE } from '../common/includes';
import { usd as usdScale } from '../common/money';
import { priceGroupOut } from '../common/serialize';
import { Tx } from '../common/tx';
import { AuthUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { TombstonesService } from '../sync/tombstones.service';
import {
  CreatePriceGroupDto,
  PriceRuleDto,
  UpdatePriceGroupDto,
} from './dto/catalog.dto';
import { PriceInputDto, SetPriceDto } from './dto/product.dto';

export type PriceGroupAggregate = Prisma.PriceGroupGetPayload<{
  include: typeof PRICE_GROUP_INCLUDE;
}>;

/**
 * Grupos de precio.
 *
 * @deprecated 2026-09 · **Mecanismo retirado.** Cada producto volvió a tener
 * precio propio en `product_prices` y ningún precio ni ninguna regla de negocio
 * se resuelve ya por grupo: `PricingService.ruleOf` mira el producto genérico y
 * nada más, y `ProductsService.create` dejó de enganchar productos nuevos.
 *
 * El servicio, su controlador (`/price-groups`) y sus mutaciones de sync
 * (`priceGroup.create/update`, `priceGroupPrice.set`) se mantienen vivos a
 * propósito mientras dure el despliegue escalonado: el backend sale **antes** que
 * el frontend, y un cliente v5 con cola pendiente que subiera una de esas
 * mutaciones contra un servidor que ya no las conoce recibiría
 * `validation_failed`, que es un rechazo **permanente** (`push.service.PERMANENT`)
 * y le haría descartar la edición en lugar de reintentarla. Escriben sobre tablas
 * que siguen existiendo, así que no rompen nada.
 *
 * Retirar todo el bloque —servicio, controlador, handlers, DTO, `priceGroups` en
 * bootstrap/delta— cuando no queden clientes v5 y se borren las tablas.
 */
@Injectable()
export class PriceGroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tombstones: TombstonesService,
  ) {}

  async aggregate(id: string, db: Tx | PrismaService = this.prisma): Promise<PriceGroupAggregate> {
    const row = await db.priceGroup.findUnique({ where: { id }, include: PRICE_GROUP_INCLUDE });
    if (!row) throw notFound('El grupo de precio');
    return row;
  }

  async list() {
    const rows = await this.prisma.priceGroup.findMany({
      include: PRICE_GROUP_INCLUDE,
      orderBy: { name: 'asc' },
    });
    return rows.map(priceGroupOut);
  }

  async create(
    user: AuthUser,
    dto: CreatePriceGroupDto,
    opts: { db?: Tx } = {},
  ): Promise<PriceGroupAggregate> {
    const run = async (tx: Tx) => {
      const id = dto.id ?? randomUUID();
      const existing = await tx.priceGroup.findUnique({ where: { id }, include: PRICE_GROUP_INCLUDE });
      if (existing) return existing;

      if (dto.categoryId) await this.assertCategory(tx, dto.categoryId);

      await tx.priceGroup.create({
        data: {
          id,
          name: dto.name.trim(),
          categoryId: dto.categoryId ?? null,
          active: dto.active ?? true,
          ...ruleColumns(dto.rule ?? null),
        },
      });
      await this.tombstones.clear('price_group', id, tx);

      if (dto.prices?.length) await this.writePrices(tx, id, dto.prices);
      return this.aggregate(id, tx);
    };

    const group = opts.db ? await run(opts.db) : await this.prisma.$transaction(run);
    await this.audit.log(user, 'grupo_precio_creado', 'price_group', group.id, { name: group.name });
    return group;
  }

  /** LWW por campo en nombre y regla; los precios, por celda (§5). */
  async update(
    user: AuthUser,
    id: string,
    dto: UpdatePriceGroupDto,
    opts: { db?: Tx; ifMatch?: number | null } = {},
  ): Promise<PriceGroupAggregate> {
    const run = async (tx: Tx) => {
      const current = await tx.priceGroup.findUnique({ where: { id } });
      if (!current) throw notFound('El grupo de precio');

      if (opts.ifMatch !== undefined && opts.ifMatch !== null && current.rev !== opts.ifMatch) {
        throw new AppError('conflict', 'El grupo de precio cambió en otro dispositivo', {
          serverEntity: priceGroupOut(await this.aggregate(id, tx)),
        });
      }

      if (dto.categoryId) await this.assertCategory(tx, dto.categoryId);

      const data: Prisma.PriceGroupUpdateInput = {};
      if (dto.name !== undefined) data.name = dto.name.trim();
      if (dto.active !== undefined) data.active = dto.active;
      if (dto.categoryId !== undefined) {
        data.category = dto.categoryId ? { connect: { id: dto.categoryId } } : { disconnect: true };
      }
      // `rule: null` borra la regla; `rule` ausente no la toca.
      if (dto.rule !== undefined) Object.assign(data, ruleColumns(dto.rule));

      if (Object.keys(data).length) await tx.priceGroup.update({ where: { id }, data });
      if (dto.prices) await this.writePrices(tx, id, dto.prices, { replace: true });

      return this.aggregate(id, tx);
    };

    const group = opts.db ? await run(opts.db) : await this.prisma.$transaction(run);
    await this.audit.log(user, 'grupo_precio_editado', 'price_group', id, {
      fields: Object.keys(dto),
    });
    return group;
  }

  /**
   * `priceGroupPrice.set`: LWW por celda `(grupo, tipo de precio)`.
   *
   * @deprecated Ya no cambia el precio de nadie: tras la retirada del mecanismo,
   * ningún producto resuelve su precio por grupo. Sigue escribiendo la fila para
   * no rechazar la cola de un cliente v5.
   */
  async setPrice(
    user: AuthUser,
    priceGroupId: string,
    dto: SetPriceDto,
    opts: { db?: Tx } = {},
  ): Promise<PriceGroupAggregate> {
    const run = async (tx: Tx) => {
      const group = await tx.priceGroup.findUnique({ where: { id: priceGroupId } });
      if (!group) throw notFound('El grupo de precio');
      await this.assertPriceType(tx, dto.priceTypeId);

      const amount = usdScale(dto.amount, 'precio');
      await tx.priceGroupPrice.upsert({
        where: { priceGroupId_priceTypeId: { priceGroupId, priceTypeId: dto.priceTypeId } },
        create: { priceGroupId, priceTypeId: dto.priceTypeId, amount },
        update: { amount },
      });

      return this.aggregate(priceGroupId, tx);
    };

    const group = opts.db ? await run(opts.db) : await this.prisma.$transaction(run);
    await this.audit.log(user, 'precio_grupo', 'price_group', priceGroupId, {
      priceTypeId: dto.priceTypeId,
      amount: dto.amount,
    });
    return group;
  }

  async remove(user: AuthUser, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const group = await tx.priceGroup.findUnique({ where: { id } });
      if (!group) throw notFound('El grupo de precio');

      const members = await tx.product.count({ where: { priceGroupId: id } });
      if (members) {
        throw new AppError(
          'has_history',
          'El grupo tiene productos: reasígnalos antes de borrarlo',
          { members },
        );
      }

      await tx.priceGroup.delete({ where: { id } });
      await this.tombstones.record('price_group', id, user.id, tx);
    });
    await this.audit.log(user, 'grupo_precio_eliminado', 'price_group', id);
  }

  private async assertCategory(tx: Tx, id: string): Promise<void> {
    const row = await tx.category.findUnique({ where: { id }, select: { id: true } });
    if (!row) throw invalid(`La categoría ${id} no existe`);
  }

  private async assertPriceType(tx: Tx, id: string): Promise<void> {
    const row = await tx.priceType.findUnique({ where: { id }, select: { id: true } });
    if (!row) throw invalid(`El tipo de precio ${id} no existe`);
  }

  private async writePrices(
    tx: Tx,
    priceGroupId: string,
    prices: PriceInputDto[],
    opts: { replace?: boolean } = {},
  ): Promise<void> {
    const ids = new Set<string>();
    for (const p of prices) {
      if (ids.has(p.priceTypeId)) throw invalid(`El tipo de precio ${p.priceTypeId} viene repetido`);
      ids.add(p.priceTypeId);
      await this.assertPriceType(tx, p.priceTypeId);
    }

    if (opts.replace) {
      await tx.priceGroupPrice.deleteMany({
        where: { priceGroupId, priceTypeId: { notIn: [...ids] } },
      });
    }

    for (const p of prices) {
      const amount = usdScale(p.amount, 'precio');
      await tx.priceGroupPrice.upsert({
        where: { priceGroupId_priceTypeId: { priceGroupId, priceTypeId: p.priceTypeId } },
        create: { priceGroupId, priceTypeId: p.priceTypeId, amount },
        update: { amount },
      });
    }
  }
}

/**
 * La `PriceRule` del frontend → las 4 columnas aplanadas. Los CHECK de
 * `price_groups` exigen que regla y banda vayan en pareja, así que se escriben
 * las cuatro siempre (a NULL cuando no hay regla) y nunca a medias.
 */
export function ruleColumns(rule: PriceRuleDto | null) {
  if (!rule) {
    return {
      ruleMinUsd: null,
      ruleTargetUsd: null,
      ruleBandMinUsd: null,
      ruleBandMaxUsd: null,
    };
  }

  const minUsd = usdScale(rule.minUsd, 'rule.minUsd');
  const targetUsd = usdScale(rule.targetUsd, 'rule.targetUsd');
  if (targetUsd.lt(minUsd)) {
    // El CHECK `price_groups_target_ge_min_ck` lo rechazaría; el mensaje de aquí
    // explica por qué existe la regla (migración v2 del frontend).
    throw invalid('rule.targetUsd (objetivo) no puede ser menor que rule.minUsd (umbral)');
  }

  if (!rule.band) {
    return { ruleMinUsd: minUsd, ruleTargetUsd: targetUsd, ruleBandMinUsd: null, ruleBandMaxUsd: null };
  }

  const bandMin = usdScale(rule.band.minUsd, 'rule.band.minUsd');
  const bandMax = usdScale(rule.band.maxUsd, 'rule.band.maxUsd');
  if (bandMin.gt(bandMax)) throw invalid('rule.band.minUsd no puede ser mayor que maxUsd');

  return {
    ruleMinUsd: minUsd,
    ruleTargetUsd: targetUsd,
    ruleBandMinUsd: bandMin,
    ruleBandMaxUsd: bandMax,
  };
}
