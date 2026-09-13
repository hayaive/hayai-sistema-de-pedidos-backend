import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * El cursor de sincronización (ARCHITECTURE.md §4.2).
 *
 * Es el valor actual de la secuencia global `sync_rev_seq`, de la que el trigger
 * `sync_assign_rev` saca el `rev` de cada fila. Se lee de `pg_sequences` y no con
 * `currval()`, que es por sesión y explota si esta conexión todavía no consumió
 * la secuencia.
 *
 * Para el cliente es un **cursor opaco** (§6.4): que hoy sea un entero es un
 * detalle interno, no se interpreta como fecha ni se hace aritmética con él.
 */
@Injectable()
export class CursorService {
  constructor(private readonly prisma: PrismaService) {}

  async current(): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ cursor: bigint | number | null }[]>`
      SELECT COALESCE(last_value, 0) AS cursor
        FROM pg_sequences
       WHERE schemaname = current_schema() AND sequencename = 'sync_rev_seq'
    `;
    // `last_value` es NULL mientras la secuencia no se haya consumido nunca.
    return Number(rows[0]?.cursor ?? 0);
  }
}
