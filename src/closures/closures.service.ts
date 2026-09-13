import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../generated/prisma/client';
import { AppError, invalid, notFound } from '../common/errors';
import { CLOSURE_INCLUDE } from '../common/includes';
import { Dec, dec, usd as usdScale, zero } from '../common/money';
import { closureOut } from '../common/serialize';
import { businessDateOf, businessDateToUtc, isBusinessDate } from '../common/time';
import { Tx } from '../common/tx';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.types';
import { CompanyService } from '../company/company.service';
import { PrismaService } from '../prisma/prisma.service';
import { ClosuresQueryDto, CreateClosureDto } from './dto/closure.dto';

export type ClosureAggregate = Prisma.DailyClosureGetPayload<{ include: typeof CLOSURE_INCLUDE }>;

interface MethodRow {
  method_id: string;
  method_name: string;
  usd: string;
}

/**
 * Cierre de caja (ARCHITECTURE.md §3.4 y §6.6).
 *
 * El borrador lo calcula **el servidor**, que es el único que ve todos los
 * dispositivos, y agrupa por `business_date` (día contable en `America/Caracas`),
 * no por `createdAt.slice(0,10)` en UTC: con eso último una venta de las 21:00
 * cae en el día siguiente y el cierre no cuadra.
 *
 * Las sumas se hacen **en SQL con `numeric`**, nunca acumulando `number` en JS
 * (§6.1). El dinero se cuenta por fecha de RECEPCIÓN: un abono cobrado el lunes
 * pertenece a la caja del lunes aunque el pedido se facture el viernes, y por eso
 * los pagos que vienen de un abono (`from_order_deposit_id`) se excluyen del día
 * de la venta.
 *
 * Invariante a preservar: **la suma de los días = lo facturado, sin duplicar
 * abonos**.
 */
@Injectable()
export class ClosuresService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly company: CompanyService,
    private readonly audit: AuditService,
  ) {}

  /** Día contable de hoy según la zona del negocio. */
  async today(): Promise<string> {
    const company = await this.company.settings();
    return businessDateOf(new Date(), company.timezone);
  }

  /**
   * `GET /closures/draft?date=YYYY-MM-DD` — el borrador autoritativo.
   *
   * Réplica de `lib/business.closureDraft`, incluido el descuento del vuelto:
   * el cambio entregado se resta del método con el que se pagó de más (el último
   * pago de la venta).
   */
  async draft(date?: string, db: Tx | PrismaService = this.prisma) {
    const day = date ?? (await this.today());
    if (!isBusinessDate(day)) throw invalid('date tiene que ser YYYY-MM-DD');
    const businessDate = businessDateToUtc(day);

    // 1 · Dinero que entró hoy por venta. Los pagos que vienen de un abono ya se
    //     contaron el día del abono, por eso se excluyen.
    const salePayments = await db.$queryRaw<MethodRow[]>`
      SELECT p.method_id, p.method_name, SUM(p.usd_equivalent)::text AS usd
        FROM sale_payments p
        JOIN sales s ON s.id = p.sale_id
       WHERE s.status = 'completada'
         AND p.from_order_deposit_id IS NULL
         AND p.business_date = ${businessDate}
       GROUP BY p.method_id, p.method_name
    `;

    // 2 · Abonos recibidos hoy sobre pedidos (facturados o no: el dinero entró
    //     hoy en cualquier caso).
    const deposits = await db.$queryRaw<MethodRow[]>`
      SELECT d.method_id, d.method_name, SUM(d.usd_equivalent)::text AS usd
        FROM order_deposits d
       WHERE d.voided = false
         AND d.business_date = ${businessDate}
       GROUP BY d.method_id, d.method_name
    `;

    // 3 · Vuelto entregado hoy, imputado al método del último pago de la venta.
    const change = await db.$queryRaw<MethodRow[]>`
      WITH last_payment AS (
        SELECT DISTINCT ON (p.sale_id) p.sale_id, p.method_id, p.method_name
          FROM sale_payments p
         ORDER BY p.sale_id, p.position DESC
      )
      SELECT lp.method_id, lp.method_name, SUM(s.change_usd)::text AS usd
        FROM sales s
        JOIN last_payment lp ON lp.sale_id = s.id
       WHERE s.status = 'completada'
         AND s.business_date = ${businessDate}
         AND s.change_usd IS NOT NULL AND s.change_usd > 0
       GROUP BY lp.method_id, lp.method_name
    `;

    // 4 · Facturado del día (suma de totales de las ventas completadas).
    const totals = await db.$queryRaw<{ count: number; total_usd: string; total_bs: string }[]>`
      SELECT COUNT(*)::int AS count,
             COALESCE(SUM(total_usd), 0)::text AS total_usd,
             COALESCE(SUM(total_bs), 0)::text AS total_bs
        FROM sales
       WHERE status = 'completada' AND business_date = ${businessDate}
    `;

    // 5 · Abonos de pedidos aún SIN facturar recibidos hoy. Es el `depositUsd`
    //     que reporta el borrador del frontend.
    const unbilled = await db.$queryRaw<{ usd: string }[]>`
      SELECT COALESCE(SUM(d.usd_equivalent), 0)::text AS usd
        FROM order_deposits d
        JOIN orders o ON o.id = d.order_id
       WHERE d.voided = false
         AND d.business_date = ${businessDate}
         AND o.status <> 'procesado'
    `;

    const methods = await db.paymentMethod.findMany({ orderBy: [{ position: 'asc' }, { name: 'asc' }] });

    const gross = new Map<string, Dec>();
    const names = new Map<string, string>();
    for (const row of [...salePayments, ...deposits]) {
      names.set(row.method_id, row.method_name);
      gross.set(row.method_id, (gross.get(row.method_id) ?? zero()).plus(dec(row.usd)));
    }
    const changeByMethod = new Map<string, Dec>();
    for (const row of change) {
      names.set(row.method_id, row.method_name);
      changeByMethod.set(
        row.method_id,
        (changeByMethod.get(row.method_id) ?? zero()).plus(dec(row.usd)),
      );
    }

    // Se listan todos los métodos activos (aunque no tengan movimiento) más
    // cualquier método histórico que sí lo tuvo: el cajero cuenta contra esta
    // lista y un método ausente sería dinero invisible.
    const ids = new Set<string>([...methods.map((m) => m.id), ...names.keys()]);

    const byMethod = [...ids].map((id) => {
      const expected = usdScale(
        (gross.get(id) ?? zero()).minus(changeByMethod.get(id) ?? zero()),
        'expected',
      );
      return {
        methodId: id,
        methodName: methods.find((m) => m.id === id)?.name ?? names.get(id) ?? id,
        expected,
      };
    });

    const expectedUsd = usdScale(
      byMethod.reduce((acc, m) => acc.plus(m.expected), zero()),
      'expectedUsd',
    );

    return {
      date: day,
      salesCount: Number(totals[0]?.count ?? 0),
      totalUsd: dec(totals[0]?.total_usd ?? 0).toNumber(),
      totalBs: dec(totals[0]?.total_bs ?? 0).toNumber(),
      depositUsd: dec(unbilled[0]?.usd ?? 0).toNumber(),
      expectedUsd: expectedUsd.toNumber(),
      byMethod: byMethod.map((m) => ({
        methodId: m.methodId,
        methodName: m.methodName,
        expected: m.expected.toNumber(),
        // Por defecto se propone lo esperado; el cajero corrige lo que contó.
        received: m.expected.toNumber(),
      })),
    };
  }

  async list(query: ClosuresQueryDto) {
    for (const day of [query.from, query.to]) {
      if (day && !isBusinessDate(day)) throw invalid('from/to tienen que ser YYYY-MM-DD');
    }

    const where: Prisma.DailyClosureWhereInput =
      query.from || query.to
        ? {
            date: {
              ...(query.from ? { gte: businessDateToUtc(query.from) } : {}),
              ...(query.to ? { lte: businessDateToUtc(query.to) } : {}),
            },
          }
        : {};

    const [total, rows] = await Promise.all([
      this.prisma.dailyClosure.count({ where }),
      this.prisma.dailyClosure.findMany({
        where,
        include: CLOSURE_INCLUDE,
        orderBy: { date: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return { page: query.page, pageSize: query.pageSize, total, items: rows.map(closureOut) };
  }

  /**
   * Cierra el día. **Un cierre por día contable**: si ya existe, gana el primero y
   * se devuelve el existente con `already_closed` (§5). El borrador lo recalcula
   * el servidor: su número es el bueno, no el que traiga el cliente.
   */
  async create(
    user: AuthUser,
    dto: CreateClosureDto,
    ctx: { db?: Tx } = {},
  ): Promise<{ closure: ClosureAggregate; alreadyClosed: boolean }> {
    const run = async (tx: Tx) => {
      const day = dto.date ?? (await this.today());
      if (!isBusinessDate(day)) throw invalid('date tiene que ser YYYY-MM-DD');
      const date = businessDateToUtc(day);

      if (dto.id) {
        const byId = await tx.dailyClosure.findUnique({
          where: { id: dto.id },
          include: CLOSURE_INCLUDE,
        });
        if (byId) return { closure: byId, alreadyClosed: true };
      }

      const existing = await tx.dailyClosure.findUnique({
        where: { date },
        include: CLOSURE_INCLUDE,
      });
      if (existing) return { closure: existing, alreadyClosed: true };

      // El borrador autoritativo: los totales esperados NO se aceptan del cliente.
      const draft = await this.draft(day, tx);

      const receivedByMethod = new Map<string, Dec>();
      for (const line of dto.byMethod ?? []) {
        receivedByMethod.set(line.methodId, usdScale(line.received, 'received'));
      }

      const methodLines = draft.byMethod.map((m) => ({
        methodId: m.methodId,
        methodName: m.methodName,
        expected: usdScale(m.expected, 'expected'),
        // Si el cajero no declaró un método, se asume que contó lo esperado.
        received: receivedByMethod.get(m.methodId) ?? usdScale(m.expected, 'received'),
      }));

      const expectedUsd = usdScale(draft.expectedUsd, 'expectedUsd');
      const receivedUsd = usdScale(
        methodLines.reduce((acc, m) => acc.plus(m.received), zero()),
        'receivedUsd',
      );
      // El CHECK `daily_closures_difference_ck` exige exactamente esta igualdad.
      const differenceUsd = usdScale(receivedUsd.minus(expectedUsd), 'differenceUsd');

      const id = dto.id ?? randomUUID();

      await tx.dailyClosure.create({
        data: {
          id,
          date,
          userId: user.id,
          userName: user.fullName,
          salesCount: draft.salesCount,
          totalUsd: usdScale(draft.totalUsd, 'totalUsd'),
          totalBs: usdScale(draft.totalBs, 'totalBs'),
          depositUsd: usdScale(draft.depositUsd, 'depositUsd'),
          expectedUsd,
          receivedUsd,
          differenceUsd,
          note: dto.note ?? null,
          closedAt: new Date(),
        },
      });

      for (const line of methodLines) {
        await tx.closureMethod.create({
          data: {
            closureId: id,
            methodId: line.methodId,
            methodName: line.methodName,
            expected: line.expected,
            received: line.received,
          },
        });
      }

      const closure = await tx.dailyClosure.findUnique({
        where: { id },
        include: CLOSURE_INCLUDE,
      });
      if (!closure) throw notFound('El cierre');
      return { closure, alreadyClosed: false };
    };

    const result = ctx.db ? await run(ctx.db) : await this.prisma.$transaction(run);

    if (!result.alreadyClosed) {
      await this.audit.log(user, 'caja_cerrada', 'closure', result.closure.id, {
        date: dto.date,
        differenceUsd: result.closure.differenceUsd.toString(),
      });
    }
    return result;
  }

  async getOne(id: string) {
    const row = await this.prisma.dailyClosure.findUnique({
      where: { id },
      include: CLOSURE_INCLUDE,
    });
    if (!row) throw notFound('El cierre');
    return closureOut(row);
  }

  /** `already_closed` como error del contrato, para el camino HTTP. */
  static alreadyClosed(closure: ClosureAggregate): AppError {
    return new AppError('already_closed', 'Ese día ya tiene cierre', {
      serverEntity: closureOut(closure),
    });
  }
}
