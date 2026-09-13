import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

/**
 * Cliente de Prisma 7 con driver adapter (ARCHITECTURE.md §9). En Prisma 7 el
 * cliente NO lee la URL del schema: se le pasa un adaptador construido con la
 * cadena de conexión, y el cliente generado vive en `src/generated/prisma`.
 *
 * Añadido sobre el §9: el **schema** se extrae de la URL y se pasa aparte.
 * El aislamiento test/prod se hace con dos schemas de la misma base
 * (`?schema=test` · `?schema=public`), y `pg` ignora ese parámetro de la query
 * string — es una convención de Prisma, no de libpq. Sin esto, un despliegue de
 * `test` escribiría en `public` y mezclaría los datos de producción, que es
 * exactamente lo que la separación por schema quiere evitar.
 *
 * Se hacen dos cosas con el schema:
 *  1. `PrismaPg(..., { schema })` → lo usan las consultas que genera Prisma.
 *  2. `options: -c search_path=...` → lo usa el SQL crudo (`$queryRaw`), que el
 *     adaptador manda tal cual. El cierre de caja y el delta de sincronización
 *     suman con SQL, así que sin esto leerían de otro schema.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private static readonly log = new Logger(PrismaService.name);

  constructor() {
    const raw = process.env.DATABASE_URL;
    if (!raw) throw new Error('Falta DATABASE_URL');

    const { connectionString, schema } = PrismaService.parseUrl(raw);

    super({
      adapter: new PrismaPg(
        {
          connectionString,
          // `search_path` para el SQL crudo. `public` se deja en la lista para
          // que sigan resolviendo las extensiones instaladas ahí.
          options: `-c search_path=${schema === 'public' ? 'public' : `${schema},public`}`,
          max: Number(process.env.DATABASE_POOL_MAX ?? 10),
        },
        { schema },
      ),
    });

    PrismaService.log.log(`Prisma apuntando al schema "${schema}"`);
  }

  /**
   * Separa el schema del resto de la cadena. Se quita de la query string porque
   * `pg` reenvía los parámetros que no conoce al servidor como parámetros de
   * sesión, y `schema` no es uno: la conexión fallaría con
   * "unrecognized configuration parameter".
   */
  static parseUrl(raw: string): { connectionString: string; schema: string } {
    try {
      const url = new URL(raw);
      const schema = url.searchParams.get('schema') || 'public';
      url.searchParams.delete('schema');
      return { connectionString: url.toString(), schema };
    } catch {
      return { connectionString: raw, schema: 'public' };
    }
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
