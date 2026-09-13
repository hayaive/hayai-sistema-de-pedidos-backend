import { Injectable } from '@nestjs/common';
import { SyncEntity } from '../generated/prisma/enums';
import { Tx } from '../common/tx';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Tombstones (ARCHITECTURE.md §4.4).
 *
 * Un cliente que sólo recibe altas y cambios nunca se enteraría de un borrado.
 * Los tombstones comparten la secuencia `rev` con el resto, así que un solo
 * cursor cubre altas, cambios y borrados.
 *
 * **Todo borrado tiene que pasar por aquí**: un `delete` suelto en un servicio es
 * un registro que se queda vivo para siempre en la caché de cada dispositivo.
 */
@Injectable()
export class TombstonesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Asienta el tombstone. Idempotente: reborrar no falla ni duplica. */
  async record(
    entity: SyncEntity,
    entityId: string,
    userId: string | null,
    tx: Tx | PrismaService = this.prisma,
  ): Promise<void> {
    await tx.syncDeletion.upsert({
      where: { entity_entityId: { entity, entityId } },
      create: { entity, entityId, deletedByUserId: userId },
      // Un reborrado mueve el `rev` para que el tombstone vuelva a viajar; el
      // trigger `sync_assign_rev` sólo bumpea si la fila cambia de verdad, así
      // que se toca `deletedAt`.
      update: { deletedAt: new Date(), deletedByUserId: userId },
    });
  }

  /**
   * Si un id borrado se vuelve a crear (raro, los ids son UUID) hay que quitar su
   * tombstone en la MISMA transacción: si no, el delta le diría al cliente
   * "créalo" y "bórralo" en la misma respuesta y el resultado dependería del
   * orden de aplicación.
   */
  async clear(
    entity: SyncEntity,
    entityId: string,
    tx: Tx | PrismaService = this.prisma,
  ): Promise<void> {
    await tx.syncDeletion.deleteMany({ where: { entity, entityId } });
  }
}
