import { Injectable, Logger } from '@nestjs/common';
import { invalid } from '../common/errors';
import { normalizeCedula } from '../common/ids';
import { bs as bsScale, qty as qtyScale, rateOf, usd as usdScale } from '../common/money';
import { clampClientTime, parseDate } from '../common/time';
import { Tx } from '../common/tx';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { ImportStateDto } from './dto/import.dto';

/** Cuántas filas se escribieron de cada cosa. */
export interface ImportReport {
  categories: number;
  priceTypes: number;
  priceGroups: number;
  products: number;
  customers: number;
  rates: number;
  paymentMethods: number;
  skipped: string[];
}

/**
 * Importación inicial del `AppState` (ARCHITECTURE.md §8, "Primera puesta en
 * marcha", paso 3).
 *
 * El dispositivo que hoy tiene el `localStorage` bueno sube su estado una vez. Es
 * el camino que **preserva los ids semánticos** (`prod-P060`, `cat-tortas-frias`,
 * `pt-mayor`) en lugar de rehacer el catálogo a mano y que deje de coincidir con
 * las constantes del frontend.
 *
 * Es **idempotente por id**: correrla dos veces no duplica nada. Lo que ya existe
 * en el servidor **no se sobreescribe**: el servidor es la fuente de verdad desde
 * el momento en que arranca, y una segunda importación desde un equipo con datos
 * viejos no debe poder revertir lo que ya se trabajó aquí.
 *
 * Qué NO importa, a propósito:
 *  · ventas, pedidos, abonos, movimientos y cierres. Son dinero y existencia: si
 *    entraran por aquí saltándose `createSale`, el inventario y la numeración
 *    quedarían descuadrados desde el primer día. El histórico operativo se migra,
 *    si hace falta, con un proceso revisado aparte.
 *  · usuarios: el `AppState` del frontend trae la contraseña en texto plano y no
 *    hay forma de convertirla en un hash argon2id sin conocerla. Los usuarios se
 *    crean con `POST /users`.
 */
@Injectable()
export class AdminService {
  private readonly log = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async importState(user: AuthUser, dto: ImportStateDto): Promise<ImportReport> {
    const report: ImportReport = {
      categories: 0,
      priceTypes: 0,
      priceGroups: 0,
      products: 0,
      customers: 0,
      rates: 0,
      paymentMethods: 0,
      skipped: [],
    };

    // Una sola transacción: un catálogo a medias es peor que ninguno, porque el
    // siguiente intento ya no sabría qué falta.
    await this.prisma.$transaction(
      async (tx) => {
        await this.importCategories(tx, dto, report);
        await this.importPriceTypes(tx, dto, report);
        await this.importPaymentMethods(tx, dto, report);
        await this.importPriceGroups(tx, dto, report);
        await this.importProducts(tx, dto, report);
        await this.importCustomers(tx, dto, report);
        await this.importRates(tx, dto, report, user);
      },
      { timeout: 120_000 },
    );

    await this.audit.log(user, 'estado_importado', 'company', 'singleton', report);
    return report;
  }

  private async importCategories(tx: Tx, dto: ImportStateDto, report: ImportReport) {
    for (const c of dto.categories ?? []) {
      const existing = await tx.category.findUnique({ where: { id: c.id } });
      if (existing) continue;
      await tx.category.create({
        data: { id: c.id, name: c.name, active: c.active ?? true },
      });
      report.categories++;
    }
  }

  private async importPriceTypes(tx: Tx, dto: ImportStateDto, report: ImportReport) {
    for (const [index, pt] of (dto.priceTypes ?? []).entries()) {
      const existing = await tx.priceType.findUnique({ where: { id: pt.id } });
      if (existing) continue;
      await tx.priceType.create({
        data: {
          id: pt.id,
          name: pt.name,
          // El default se decide después: el índice único parcial sólo admite uno.
          isDefault: false,
          position: index,
        },
      });
      report.priceTypes++;
    }

    const wantedDefault = (dto.priceTypes ?? []).find((pt) => pt.isDefault);
    const currentDefault = await tx.priceType.findFirst({ where: { isDefault: true } });
    if (wantedDefault && !currentDefault) {
      await tx.priceType.update({ where: { id: wantedDefault.id }, data: { isDefault: true } });
    }
  }

  private async importPaymentMethods(tx: Tx, dto: ImportStateDto, report: ImportReport) {
    for (const [index, pm] of (dto.paymentMethods ?? []).entries()) {
      const existing = await tx.paymentMethod.findUnique({ where: { id: pm.id } });
      if (existing) continue;
      await tx.paymentMethod.create({
        data: {
          id: pm.id,
          name: pm.name,
          currency: pm.currency,
          requiresReference: pm.requiresReference ?? false,
          active: pm.active ?? true,
          position: index,
        },
      });
      report.paymentMethods++;
    }
  }

  private async importPriceGroups(tx: Tx, dto: ImportStateDto, report: ImportReport) {
    for (const g of dto.priceGroups ?? []) {
      const existing = await tx.priceGroup.findUnique({ where: { id: g.id } });
      if (existing) continue;

      // La `PriceRule` se aplana en las 4 columnas; los CHECK exigen que regla y
      // banda vayan en pareja, así que se escriben las cuatro o ninguna.
      const hasRule = g.rule && g.rule.minUsd !== undefined && g.rule.targetUsd !== undefined;
      const band = hasRule && g.rule?.band ? g.rule.band : null;

      await tx.priceGroup.create({
        data: {
          id: g.id,
          name: g.name,
          categoryId: g.categoryId ?? null,
          active: g.active ?? true,
          ruleMinUsd: hasRule ? usdScale(g.rule!.minUsd, 'rule.minUsd') : null,
          ruleTargetUsd: hasRule
            ? usdScale(Math.max(g.rule!.targetUsd, g.rule!.minUsd), 'rule.targetUsd')
            : null,
          ruleBandMinUsd: band ? usdScale(band.minUsd, 'band.minUsd') : null,
          ruleBandMaxUsd: band ? usdScale(band.maxUsd, 'band.maxUsd') : null,
        },
      });

      for (const price of g.prices ?? []) {
        await tx.priceGroupPrice.upsert({
          where: {
            priceGroupId_priceTypeId: { priceGroupId: g.id, priceTypeId: price.priceTypeId },
          },
          create: {
            priceGroupId: g.id,
            priceTypeId: price.priceTypeId,
            amount: usdScale(price.amount, 'precio'),
          },
          update: {},
        });
      }
      report.priceGroups++;
    }
  }

  private async importProducts(tx: Tx, dto: ImportStateDto, report: ImportReport) {
    for (const p of dto.products ?? []) {
      const existing = await tx.product.findUnique({ where: { id: p.id } });
      if (existing) continue;

      // Un código retirado no vuelve a circular: el trigger lo rechazaría, pero
      // aquí se anota y se salta para que la importación no muera entera por un
      // producto que el propio esquema v3 del frontend ya había consolidado.
      const retired = await tx.retiredProductCode.findUnique({ where: { code: p.code } });
      if (retired) {
        report.skipped.push(`producto ${p.code} (código retirado)`);
        continue;
      }

      const byCode = await tx.product.findUnique({ where: { code: p.code } });
      if (byCode) {
        report.skipped.push(`producto ${p.code} (código ya usado por ${byCode.id})`);
        continue;
      }

      await tx.product.create({
        data: {
          id: p.id,
          code: p.code,
          name: p.name,
          description: p.description ?? null,
          categoryId: p.categoryId,
          imageUrl: p.imageUrl ?? null,
          // El stock NO se importa como valor: entra como un movimiento de ajuste,
          // para que el ledger explique de dónde viene la existencia y la
          // invariante `SUM(delta) = stock` se cumpla desde el primer día.
          stock: 0,
          minStock: qtyScale(p.minStock ?? 0, 'minStock'),
          active: p.active ?? true,
          bsOnly: p.bsOnly ?? false,
          bsPrice: p.bsPrice === undefined ? null : bsScale(p.bsPrice, 'bsPrice'),
          priceGroupId: p.priceGroupId ?? null,
          isCombo: p.isCombo ?? false,
          allowCustomization: p.allowCustomization ?? false,
          customizationPrice:
            p.customizationPrice === undefined
              ? null
              : usdScale(p.customizationPrice, 'customizationPrice'),
        },
      });

      for (const price of p.prices ?? []) {
        await tx.productPrice.upsert({
          where: { productId_priceTypeId: { productId: p.id, priceTypeId: price.priceTypeId } },
          create: {
            productId: p.id,
            priceTypeId: price.priceTypeId,
            amount: usdScale(price.amount, 'precio'),
          },
          update: {},
        });
      }

      for (const [position, item] of (p.comboItems ?? []).entries()) {
        await tx.comboItem.create({
          data: {
            id: `${p.id}-combo-${position}`,
            comboProductId: p.id,
            position,
            description: item.description,
            qty: qtyScale(item.qty, 'cantidad del combo'),
            // El componente se conecta sólo si el producto ya existe: los combos son
            // descriptivos y una referencia rota no debe tumbar la importación.
            componentProductId: item.productId
              ? ((await tx.product.findUnique({
                  where: { id: item.productId },
                  select: { id: true },
                }))?.id ?? null)
              : null,
          },
        });
      }

      // El stock inicial, como ajuste firmado por el usuario técnico.
      if (p.stock !== undefined && p.stock !== null && p.stock !== 0) {
        const target = qtyScale(p.stock, 'stock');
        await tx.inventoryMovement.create({
          data: {
            id: `import-${p.id}`,
            productId: p.id,
            type: 'ajuste',
            qty: target,
            delta: target,
            stockAfter: target,
            reason: 'Importación del estado inicial',
            userId: 'system',
          },
        });
        await tx.product.update({ where: { id: p.id }, data: { stock: target } });
      }

      report.products++;
    }
  }

  private async importCustomers(tx: Tx, dto: ImportStateDto, report: ImportReport) {
    for (const c of dto.customers ?? []) {
      const cedula = normalizeCedula(c.cedula);
      if (!cedula) {
        report.skipped.push(`cliente ${c.id} (cédula vacía)`);
        continue;
      }

      const byId = await tx.customer.findUnique({ where: { id: c.id } });
      if (byId) continue;

      // La cédula es la identidad: si ya está, es la misma persona y se conserva la
      // fila del servidor (fusión, igual que en la cola offline).
      const byCedula = await tx.customer.findUnique({ where: { cedula } });
      if (byCedula) {
        report.skipped.push(`cliente ${cedula} (ya existe como ${byCedula.id})`);
        continue;
      }

      await tx.customer.create({
        data: {
          id: c.id,
          cedula,
          name: c.name,
          phone: c.phone ?? null,
          address: c.address ?? null,
          active: c.active ?? true,
        },
      });
      report.customers++;
    }
  }

  private async importRates(
    tx: Tx,
    dto: ImportStateDto,
    report: ImportReport,
    user: AuthUser,
  ) {
    for (const r of dto.rates ?? []) {
      const existing = await tx.exchangeRate.findUnique({ where: { id: r.id } });
      if (existing) continue;

      const value = rateOf(r.value, 'tasa');
      if (value.lte(0)) {
        report.skipped.push(`tasa ${r.id} (valor no positivo)`);
        continue;
      }

      // Las tasas importadas conservan su fecha: la vigente es la de `createdAt`
      // mayor, y aplanarlas a "ahora" haría que la más vieja pasara por actual.
      const createdAt = parseDate(r.createdAt);
      await tx.exchangeRate.create({
        data: {
          id: r.id,
          source: r.source,
          currency: r.source === 'BCV_EUR' ? 'EUR' : 'USD',
          value,
          automatic: r.automatic ?? false,
          // `userId` se deja nulo si el id del frontend no corresponde a un usuario
          // de esta base: la FK es SET NULL y una tasa sin autor sigue siendo válida.
          userId: r.userId
            ? ((await tx.user.findUnique({ where: { id: r.userId }, select: { id: true } }))?.id ??
              null)
            : null,
          ...(createdAt ? { createdAt: clampClientTime(createdAt).at } : {}),
        },
      });
      report.rates++;
    }

    if ((dto.rates ?? []).length === 0) {
      this.log.warn(`Importación sin tasas: ${user.username} tendrá que publicar una para cobrar en Bs`);
    }
  }

  /** Comprobación previa: qué encontraría la importación, sin escribir nada. */
  async dryRun(dto: ImportStateDto) {
    const counts = {
      categories: (dto.categories ?? []).length,
      priceTypes: (dto.priceTypes ?? []).length,
      priceGroups: (dto.priceGroups ?? []).length,
      products: (dto.products ?? []).length,
      customers: (dto.customers ?? []).length,
      rates: (dto.rates ?? []).length,
      paymentMethods: (dto.paymentMethods ?? []).length,
    };

    if (Object.values(counts).every((n) => n === 0)) {
      throw invalid('El estado a importar está vacío');
    }

    const codes = (dto.products ?? []).map((p) => p.code);
    const retired = await this.prisma.retiredProductCode.findMany({
      where: { code: { in: codes } },
      select: { code: true },
    });

    return { counts, retiredCodes: retired.map((r) => r.code) };
  }
}
