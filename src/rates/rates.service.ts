import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, ExchangeRate } from '../generated/prisma/client';
import { RateCurrency, RateSource } from '../generated/prisma/enums';
import { invalid } from '../common/errors';
import { Dec, dec, rateOf, zero } from '../common/money';
import { rateOut } from '../common/serialize';
import { Tx } from '../common/tx';
import { AuthUser } from '../auth/auth.types';
import { AppConfig } from '../config/app-config';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateRateDto, RatesQueryDto } from './dto/rate.dto';

/** Fuente canónica de conversión a bolívares (`lib/pricing-rules.SALE_RATE_SOURCE`). */
export const SALE_RATE_SOURCE: RateSource = 'BCV_USD';

export interface RateSnapshot {
  usd: Dec;
  eur: Dec;
  binance: Dec;
  at: Date;
}

/** La moneda de cada fuente. `BCV_EUR` es la única en euros. */
export function currencyOf(source: RateSource): RateCurrency {
  return source === 'BCV_EUR' ? 'EUR' : 'USD';
}

@Injectable()
export class RatesService {
  private readonly log = new Logger(RatesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: AppConfig,
    private readonly audit: AuditService,
  ) {}

  /**
   * Tasa vigente de una fuente: la de `created_at` máximo (`lib/pricing.currentRate`).
   * Nunca se sobreescribe una tasa, se publica una nueva, así que "vigente" es
   * siempre una consulta y no un campo.
   */
  async current(source: RateSource, db: Tx | PrismaService = this.prisma) {
    return db.exchangeRate.findFirst({ where: { source }, orderBy: { createdAt: 'desc' } });
  }

  /** Tasa BCV USD vigente, 0 si no hay ninguna (igual que `bcvRate`). */
  async bcvRate(db: Tx | PrismaService = this.prisma): Promise<Dec> {
    const row = await this.current(SALE_RATE_SOURCE, db);
    return row ? dec(row.value) : zero();
  }

  /**
   * Las tres tasas vigentes, para congelarlas en una venta. `at` es el momento
   * del cobro, no el de publicación de la tasa: es lo que hace `rateSnapshot()`
   * en el frontend y lo que permite reimprimir el comprobante con la tasa real.
   */
  async snapshot(db: Tx | PrismaService = this.prisma): Promise<RateSnapshot> {
    const [usd, eur, binance] = await Promise.all([
      this.current('BCV_USD', db),
      this.current('BCV_EUR', db),
      this.current('BINANCE', db),
    ]);
    return {
      usd: usd ? dec(usd.value) : zero(),
      eur: eur ? dec(eur.value) : zero(),
      binance: binance ? dec(binance.value) : zero(),
      at: new Date(),
    };
  }

  async list(query: RatesQueryDto) {
    const where: Prisma.ExchangeRateWhereInput = query.source ? { source: query.source } : {};
    const [total, rows] = await Promise.all([
      this.prisma.exchangeRate.count({ where }),
      this.prisma.exchangeRate.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return { page: query.page, pageSize: query.pageSize, total, items: rows.map(rateOut) };
  }

  /** Las vigentes de las tres fuentes, que es lo que la UI necesita para cobrar. */
  async currentAll() {
    const [usd, eur, binance] = await Promise.all([
      this.current('BCV_USD'),
      this.current('BCV_EUR'),
      this.current('BINANCE'),
    ]);
    return {
      BCV_USD: usd ? rateOut(usd) : null,
      BCV_EUR: eur ? rateOut(eur) : null,
      BINANCE: binance ? rateOut(binance) : null,
    };
  }

  /**
   * Publica una tasa. Append-only e idempotente por PK: reenviar la misma
   * mutación offline no duplica la tasa (§5).
   */
  async publish(
    input: {
      id?: string;
      source: RateSource;
      value: Dec | number | string;
      automatic?: boolean;
      userId?: string | null;
      createdAt?: Date;
      deviceId?: string | null;
    },
    db: Tx | PrismaService = this.prisma,
  ): Promise<ExchangeRate> {
    const value = rateOf(input.value, 'tasa');
    if (value.lte(0)) throw invalid('La tasa tiene que ser mayor que cero');

    const id = input.id ?? randomUUID();

    const existing = await db.exchangeRate.findUnique({ where: { id } });
    if (existing) return existing;

    return db.exchangeRate.create({
      data: {
        id,
        source: input.source,
        currency: currencyOf(input.source),
        value,
        automatic: input.automatic ?? false,
        userId: input.userId ?? null,
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      },
    });
  }

  async create(user: AuthUser, dto: CreateRateDto) {
    const row = await this.publish({
      id: dto.id,
      source: dto.source,
      value: dto.value,
      automatic: false,
      userId: user.id,
    });
    await this.audit.log(user, 'tasa_manual', 'exchange_rate', dto.source, { value: dto.value });
    return rateOut(row);
  }

  /**
   * Trae la tasa oficial DESDE EL SERVIDOR (§6.6).
   *
   * Hoy cada navegador llama a `ve.dolarapi.com` por su cuenta: eso multiplica
   * llamadas, sufre CORS y permite que dos cajas cobren a tasas distintas el
   * mismo minuto. Con un solo publicador todos ven la misma tasa, y un equipo
   * offline la recibe al sincronizar.
   *
   * Las tasas automáticas se asientan con `userId = null`, igual que el
   * frontend (`ExchangeRate.userId: ID | null`).
   */
  async fetchFromApi(actor?: AuthUser): Promise<{
    ok: boolean;
    message: string;
    published: { source: RateSource; value: number }[];
  }> {
    const base = this.cfg.ratesApiUrl.replace(/\/+$/, '');
    const published: { source: RateSource; value: number }[] = [];

    try {
      const dolares = await fetchJson<{ fuente?: string; promedio?: number }[]>(`${base}/dolares`);
      const pick = (fuente: string) =>
        Array.isArray(dolares) ? dolares.find((d) => d?.fuente === fuente)?.promedio : undefined;

      const oficial = pick('oficial');
      const paralelo = pick('paralelo');

      if (isPositive(oficial)) {
        await this.publish({ source: 'BCV_USD', value: oficial, automatic: true, userId: null });
        published.push({ source: 'BCV_USD', value: oficial });
      }
      if (isPositive(paralelo)) {
        await this.publish({ source: 'BINANCE', value: paralelo, automatic: true, userId: null });
        published.push({ source: 'BINANCE', value: paralelo });
      }

      // El euro viene con otra forma según la versión de la API: se aceptan las
      // dos que el frontend ya contemplaba.
      const euro = await fetchJson<{ promedio?: number; oficial?: { promedio?: number } }>(
        `${base}/euro`,
      ).catch(() => null);
      const eur = euro?.oficial?.promedio ?? euro?.promedio;
      if (isPositive(eur)) {
        await this.publish({ source: 'BCV_EUR', value: eur, automatic: true, userId: null });
        published.push({ source: 'BCV_EUR', value: eur });
      }

      if (!published.length) {
        return { ok: false, message: 'La fuente no devolvió ninguna tasa utilizable', published };
      }

      await this.audit.log(
        actor ?? { id: 'system', fullName: 'Sistema' },
        'tasa_automatica',
        'exchange_rate',
        published.map((p) => p.source).join(','),
        { published },
      );

      return { ok: true, message: 'Tasas actualizadas desde la fuente oficial', published };
    } catch (err) {
      this.log.warn(`No se pudo consultar ${base}: ${(err as Error).message}`);
      return {
        ok: false,
        message: 'No se pudo consultar la fuente oficial. Publica las tasas manualmente.',
        published,
      };
    }
  }
}

const isPositive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}
