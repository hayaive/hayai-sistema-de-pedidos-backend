import { Injectable } from '@nestjs/common';
import { RateSource } from '../generated/prisma/enums';
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
  retiredCodeOut,
  roleOut,
  saleOut,
  userOut,
} from '../common/serialize';
import { serverTime } from '../common/time';
import { AppConfig } from '../config/app-config';
import { CompanyService } from '../company/company.service';
import { PrismaService } from '../prisma/prisma.service';
import { CursorService } from './cursor.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const SOURCES: RateSource[] = ['BCV_USD', 'BCV_EUR', 'BINANCE'];

/**
 * `GET /bootstrap` (ARCHITECTURE.md §6.3).
 *
 * La forma es la de `AppState` del frontend (sin `sessionUserId`, con `cursor`)
 * para que hidrate su caché directamente.
 *
 * **Es una ventana, no el histórico completo.** Una caché offline no puede ser el
 * libro mayor: el catálogo, la configuración, los clientes, los usuarios y los
 * roles van completos, pero ventas, movimientos, cierres y bitácora van recortados
 * y lo viejo se consulta con los endpoints paginados, en línea.
 *
 * El `cursor` se lee **antes** de las consultas: si se leyera después, un cambio
 * que ocurriera entre medias quedaría por debajo del cursor devuelto y el
 * dispositivo no lo recibiría nunca. Leerlo antes sólo puede provocar que el
 * primer `GET /sync` reenvíe algo que ya venía, y reaplicar es inocuo.
 */
@Injectable()
export class BootstrapService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: AppConfig,
    private readonly cursor: CursorService,
    private readonly company: CompanyService,
  ) {}

  async build() {
    const cursor = await this.cursor.current();
    const now = new Date();

    const windowDays = this.cfg.bootstrapWindowDays;
    const from = new Date(now.getTime() - windowDays * DAY_MS);
    const ratesFrom = new Date(now.getTime() - this.cfg.bootstrapRatesDays * DAY_MS);
    const closuresFrom = new Date(now.getTime() - this.cfg.bootstrapClosuresDays * DAY_MS);

    const [
      company,
      roles,
      users,
      categories,
      priceTypes,
      priceGroups,
      products,
      paymentMethods,
      customers,
      retiredProductCodes,
    ] = await Promise.all([
      this.company.settings(),
      this.prisma.role.findMany({ include: ROLE_INCLUDE, orderBy: { name: 'asc' } }),
      // El usuario técnico no viaja: no es una persona y su hash es un literal
      // inválido a propósito.
      this.prisma.user.findMany({ where: { system: false }, orderBy: { username: 'asc' } }),
      this.prisma.category.findMany({ orderBy: { name: 'asc' } }),
      this.prisma.priceType.findMany({ orderBy: [{ position: 'asc' }, { name: 'asc' }] }),
      this.prisma.priceGroup.findMany({ include: PRICE_GROUP_INCLUDE, orderBy: { name: 'asc' } }),
      this.prisma.product.findMany({ include: PRODUCT_INCLUDE, orderBy: { code: 'asc' } }),
      this.prisma.paymentMethod.findMany({ orderBy: [{ position: 'asc' }, { name: 'asc' }] }),
      this.prisma.customer.findMany({ orderBy: { name: 'asc' } }),
      this.prisma.retiredProductCode.findMany({ orderBy: { code: 'asc' } }),
    ]);

    const [rates, currentRates, orders, sales, movements, closures, audit] = await Promise.all([
      // Tasas de la ventana...
      this.prisma.exchangeRate.findMany({
        where: { createdAt: { gte: ratesFrom } },
        orderBy: { createdAt: 'desc' },
      }),
      // ...más la vigente de cada fuente, aunque sea más antigua que la ventana:
      // sin ella un equipo que lleva semanas sin tasa nueva no podría cobrar en Bs.
      Promise.all(
        SOURCES.map((source) =>
          this.prisma.exchangeRate.findFirst({ where: { source }, orderBy: { createdAt: 'desc' } }),
        ),
      ),
      // TODOS los pedidos no terminales (un pedido pendiente de hace meses sigue
      // siendo trabajo por hacer) más los terminales de la ventana.
      this.prisma.order.findMany({
        where: {
          OR: [
            { status: { notIn: ['procesado', 'cancelado'] } },
            { createdAt: { gte: from } },
          ],
        },
        include: ORDER_INCLUDE,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.sale.findMany({
        where: { createdAt: { gte: from } },
        include: SALE_INCLUDE,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.inventoryMovement.findMany({
        where: { createdAt: { gte: from } },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.dailyClosure.findMany({
        where: { date: { gte: closuresFrom } },
        include: CLOSURE_INCLUDE,
        orderBy: { date: 'desc' },
      }),
      this.prisma.auditLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: this.cfg.bootstrapAuditLimit,
      }),
    ]);

    // Las tasas vigentes que quedaron fuera de la ventana se añaden sin duplicar.
    const rateIds = new Set(rates.map((r) => r.id));
    for (const rate of currentRates) {
      if (rate && !rateIds.has(rate.id)) {
        rates.push(rate);
        rateIds.add(rate.id);
      }
    }

    // Los abonos viajan embebidos en su pedido y también como entidad propia: en
    // el delta son una raíz con `rev` aparte, así que el cliente tiene que
    // conocerlos como tales desde el principio.
    const orderDeposits = orders.flatMap((o) => o.deposits);

    return {
      cursor,
      serverTime: serverTime(),
      schemaVersion: company.schemaVersion,
      window: {
        days: windowDays,
        from: from.toISOString(),
        to: now.toISOString(),
        closuresDays: this.cfg.bootstrapClosuresDays,
        auditLimit: this.cfg.bootstrapAuditLimit,
      },
      company: companyOut(company),
      roles: roles.map(roleOut),
      users: users.map(userOut),
      categories: categories.map(categoryOut),
      priceTypes: priceTypes.map(priceTypeOut),
      priceGroups: priceGroups.map(priceGroupOut),
      products: products.map(productOut),
      paymentMethods: paymentMethods.map(paymentMethodOut),
      rates: rates.map(rateOut),
      customers: customers.map(customerOut),
      orders: orders.map(orderOut),
      orderDeposits: orderDeposits.map(depositOut),
      sales: sales.map(saleOut),
      movements: movements.map(movementOut),
      closures: closures.map(closureOut),
      audit: audit.map(auditOut),
      retiredProductCodes: retiredProductCodes.map(retiredCodeOut),
    };
  }
}
