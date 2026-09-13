import { Injectable } from '@nestjs/common';
import { AppError } from '../common/errors';
import {
  CLOSURE_INCLUDE,
  ORDER_INCLUDE,
  PRICE_GROUP_INCLUDE,
  PRODUCT_INCLUDE,
  ROLE_INCLUDE,
  SALE_INCLUDE,
} from '../common/includes';
import {
  auditOut,
  categoryOut,
  closureOut,
  companyOut,
  customerOut,
  depositOut,
  movementOut,
  orderOut,
  paymentMethodOut,
  priceGroupOut,
  priceTypeOut,
  productOut,
  rateOut,
  roleOut,
  saleOut,
  userOut,
} from '../common/serialize';
import { serverTime } from '../common/time';
import { AppConfig } from '../config/app-config';
import { PrismaService } from '../prisma/prisma.service';
import { CursorService } from './cursor.service';

/**
 * Las raíces de agregado que viajan en el delta, en el **orden de aplicación por
 * FK** que manda §6.4. El cliente aplica en este orden, así que el servidor las
 * emite igual: si `products` llegara antes que `categories`, un upsert por id
 * fallaría en el cliente por una FK que todavía no existe.
 */
const ENTITY_ORDER = [
  'company',
  'categories',
  'priceTypes',
  'priceGroups',
  'products',
  'paymentMethods',
  'roles',
  'users',
  'customers',
  'orders',
  'orderDeposits',
  'sales',
  'movements',
  'closures',
  'audit',
] as const;

type EntityKey = (typeof ENTITY_ORDER)[number];

/** Un id con su `rev`, para decidir el corte de la página sin cargar el agregado. */
interface Head {
  entity: EntityKey;
  id: string;
  rev: number;
}

@Injectable()
export class DeltaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: AppConfig,
    private readonly cursor: CursorService,
  ) {}

  /**
   * `GET /sync?since=<cursor>` (§6.4).
   *
   * Cómo se pagina sin partir un agregado: primero se piden sólo `(id, rev)` de
   * cada raíz cambiada, se mezclan en una sola lista ordenada por `rev` —que es un
   * orden total, sin empates— y se corta en `limit`. El cursor devuelto es el `rev`
   * del último agregado entregado, así que el corte es exacto y el cliente puede
   * volver a pedir de inmediato.
   *
   * La **ventana de reenvío** (`SYNC_RESEND_WINDOW`) cubre el hueco teórico de una
   * transacción que tomó un `rev` bajo y commiteó después de que un poll ya sirvió
   * un `rev` más alto: se consulta desde `cursor − ventana`. Como el delta manda
   * agregados completos y el cliente los aplica por id de forma idempotente,
   * reenviar unas filas de más no cuesta nada.
   */
  async delta(since: number, limitInput?: number) {
    const limit = Math.min(limitInput ?? this.cfg.syncPageLimit, 2000);

    await this.assertCursorFresh(since);

    // Ventana de reenvío: nunca por debajo de 0.
    const floor = Math.max(0, since - this.cfg.syncResendWindow);

    const heads = await this.heads(floor, limit);

    // El corte: los `rev` son únicos en toda la base (secuencia global), así que
    // ordenar por `rev` y cortar no puede dejar medio agregado fuera.
    heads.sort((a, b) => a.rev - b.rev);
    const page = heads.slice(0, limit);
    const hasMore = heads.length > limit;

    // Si no hubo cambios, el cursor avanza al actual: así un dispositivo al día no
    // se queda reconsultando el mismo tramo para siempre.
    const nextCursor = page.length ? page[page.length - 1].rev : await this.cursor.current();

    const byEntity = new Map<EntityKey, string[]>();
    for (const head of page) {
      const list = byEntity.get(head.entity) ?? [];
      list.push(head.id);
      byEntity.set(head.entity, list);
    }

    const changes = await this.load(byEntity);

    // Los tombstones comparten la secuencia, así que se cortan con el mismo
    // cursor: entregar un borrado por encima del cursor lo perdería en el
    // siguiente poll.
    const deletions = await this.prisma.syncDeletion.findMany({
      where: { rev: { gt: floor, lte: nextCursor } },
      orderBy: { rev: 'asc' },
    });

    return {
      cursor: nextCursor,
      hasMore,
      serverTime: serverTime(),
      changes,
      deletions: deletions.map((d) => ({ entity: d.entity, id: d.entityId })),
    };
  }

  /**
   * Si el cursor del cliente es más viejo que la retención de tombstones, los
   * borrados que se perdió pueden haber sido purgados: ya no hay forma de contarle
   * lo que desapareció, así que tiene que rehacer `/bootstrap` (§4.4).
   *
   * El corte se calcula contra el `rev` más alto de los tombstones que ya
   * cumplieron la retención: por encima de eso el cliente no se perdió nada
   * purgable.
   */
  private async assertCursorFresh(since: number): Promise<void> {
    if (since <= 0) return; // un cursor 0 ya es un bootstrap

    const retentionMs = this.cfg.syncTombstoneRetentionDays * 24 * 60 * 60 * 1000;
    const cutoff = new Date(Date.now() - retentionMs);

    const stale = await this.prisma.syncDeletion.aggregate({
      where: { deletedAt: { lt: cutoff } },
      _max: { rev: true },
    });

    const watermark = stale._max.rev ?? 0;
    if (since < watermark) {
      throw new AppError(
        'cursor_too_old',
        'El cursor es más antiguo que la retención de tombstones: hay que rehacer /bootstrap',
        { bootstrapRequired: true, retentionDays: this.cfg.syncTombstoneRetentionDays },
      );
    }
  }

  /** Sólo `(id, rev)` de cada raíz cambiada. `limit + 1` para saber si hay más. */
  private async heads(floor: number, limit: number): Promise<Head[]> {
    const take = limit + 1;
    const where = { rev: { gt: floor } };
    const order = { rev: 'asc' } as const;
    const select = { id: true, rev: true };

    const [
      company,
      categories,
      priceTypes,
      priceGroups,
      products,
      paymentMethods,
      roles,
      users,
      customers,
      orders,
      orderDeposits,
      sales,
      movements,
      closures,
      audit,
    ] = await Promise.all([
      this.prisma.companySettings.findMany({ where, select, orderBy: order, take }),
      this.prisma.category.findMany({ where, select, orderBy: order, take }),
      this.prisma.priceType.findMany({ where, select, orderBy: order, take }),
      this.prisma.priceGroup.findMany({ where, select, orderBy: order, take }),
      this.prisma.product.findMany({ where, select, orderBy: order, take }),
      this.prisma.paymentMethod.findMany({ where, select, orderBy: order, take }),
      this.prisma.role.findMany({ where, select, orderBy: order, take }),
      this.prisma.user.findMany({ where: { ...where, system: false }, select, orderBy: order, take }),
      this.prisma.customer.findMany({ where, select, orderBy: order, take }),
      this.prisma.order.findMany({ where, select, orderBy: order, take }),
      this.prisma.orderDeposit.findMany({ where, select, orderBy: order, take }),
      this.prisma.sale.findMany({ where, select, orderBy: order, take }),
      this.prisma.inventoryMovement.findMany({ where, select, orderBy: order, take }),
      this.prisma.dailyClosure.findMany({ where, select, orderBy: order, take }),
      this.prisma.auditLog.findMany({ where, select, orderBy: order, take }),
    ]);

    const heads: Head[] = [];
    const push = (entity: EntityKey, rows: { id: string; rev: number }[]) => {
      for (const row of rows) heads.push({ entity, id: row.id, rev: row.rev });
    };

    push('company', company);
    push('categories', categories);
    push('priceTypes', priceTypes);
    push('priceGroups', priceGroups);
    push('products', products);
    push('paymentMethods', paymentMethods);
    push('roles', roles);
    push('users', users);
    push('customers', customers);
    push('orders', orders);
    push('orderDeposits', orderDeposits);
    push('sales', sales);
    push('movements', movements);
    push('closures', closures);
    push('audit', audit);

    return heads;
  }

  /** Carga los agregados completos de la página, en el orden de aplicación. */
  private async load(byEntity: Map<EntityKey, string[]>) {
    const ids = (entity: EntityKey) => byEntity.get(entity) ?? [];
    const inIds = (entity: EntityKey) => ({ id: { in: ids(entity) } });

    const changes: Record<string, unknown> = {};

    if (ids('company').length) {
      const row = await this.prisma.companySettings.findUnique({ where: { id: 'singleton' } });
      if (row) changes.company = companyOut(row);
    }

    if (ids('categories').length) {
      const rows = await this.prisma.category.findMany({ where: inIds('categories') });
      changes.categories = rows.map(categoryOut);
    }
    if (ids('priceTypes').length) {
      const rows = await this.prisma.priceType.findMany({ where: inIds('priceTypes') });
      changes.priceTypes = rows.map(priceTypeOut);
    }
    if (ids('priceGroups').length) {
      const rows = await this.prisma.priceGroup.findMany({
        where: inIds('priceGroups'),
        include: PRICE_GROUP_INCLUDE,
      });
      changes.priceGroups = rows.map(priceGroupOut);
    }
    if (ids('products').length) {
      const rows = await this.prisma.product.findMany({
        where: inIds('products'),
        include: PRODUCT_INCLUDE,
      });
      changes.products = rows.map(productOut);
    }
    if (ids('paymentMethods').length) {
      const rows = await this.prisma.paymentMethod.findMany({ where: inIds('paymentMethods') });
      changes.paymentMethods = rows.map(paymentMethodOut);
    }
    if (ids('roles').length) {
      const rows = await this.prisma.role.findMany({
        where: inIds('roles'),
        include: ROLE_INCLUDE,
      });
      changes.roles = rows.map(roleOut);
    }
    if (ids('users').length) {
      const rows = await this.prisma.user.findMany({ where: inIds('users') });
      changes.users = rows.map(userOut);
    }
    if (ids('customers').length) {
      const rows = await this.prisma.customer.findMany({ where: inIds('customers') });
      changes.customers = rows.map(customerOut);
    }
    if (ids('orders').length) {
      const rows = await this.prisma.order.findMany({
        where: inIds('orders'),
        include: ORDER_INCLUDE,
      });
      changes.orders = rows.map(orderOut);
    }
    if (ids('orderDeposits').length) {
      const rows = await this.prisma.orderDeposit.findMany({ where: inIds('orderDeposits') });
      changes.orderDeposits = rows.map(depositOut);
    }
    if (ids('sales').length) {
      const rows = await this.prisma.sale.findMany({
        where: inIds('sales'),
        include: SALE_INCLUDE,
      });
      changes.sales = rows.map(saleOut);
    }
    if (ids('movements').length) {
      const rows = await this.prisma.inventoryMovement.findMany({ where: inIds('movements') });
      changes.movements = rows.map(movementOut);
    }
    if (ids('closures').length) {
      const rows = await this.prisma.dailyClosure.findMany({
        where: inIds('closures'),
        include: CLOSURE_INCLUDE,
      });
      changes.closures = rows.map(closureOut);
    }
    if (ids('audit').length) {
      const rows = await this.prisma.auditLog.findMany({ where: inIds('audit') });
      changes.audit = rows.map(auditOut);
    }

    // Se devuelve en el orden declarado: aunque en JSON el orden de claves no sea
    // contractual, mantenerlo hace que el volcado sea legible y que un cliente que
    // itere `Object.keys` aplique en orden de FK.
    const ordered: Record<string, unknown> = {};
    for (const key of ENTITY_ORDER) if (key in changes) ordered[key] = changes[key];
    return ordered;
  }
}
