import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Registro de dispositivos. Existe por dos razones:
 *  · varias tablas llevan `device_id` con FK, así que la fila tiene que existir
 *    antes de asentar una venta o un abono desde ese equipo;
 *  · permite auditar el origen de cada asiento y diagnosticar "este equipo no
 *    sincroniza desde el martes" (`last_seen_at`, `last_cursor`).
 *
 * El `ensure` se llama en cada petición autenticada, así que lleva una caché de
 * ids ya vistos: sin ella habría un SELECT por request para algo que cambia una
 * vez en la vida del dispositivo. La caché sólo puede fallar en el sentido
 * seguro (un id que sí existe pero no está cacheado ⇒ un upsert de más).
 */
@Injectable()
export class DevicesService {
  private readonly known = new Set<string>();

  constructor(private readonly prisma: PrismaService) {}

  /** Garantiza la fila del dispositivo. Idempotente. */
  async ensure(
    deviceId: string,
    info?: { name?: string; userAgent?: string; userId?: string },
  ): Promise<void> {
    const hasInfo = Boolean(info?.name || info?.userAgent || info?.userId);
    if (this.known.has(deviceId) && !hasInfo) return;

    await this.prisma.device.upsert({
      where: { id: deviceId },
      create: {
        id: deviceId,
        name: info?.name ?? null,
        userAgent: info?.userAgent ?? null,
        lastUserId: info?.userId ?? null,
        lastSeenAt: new Date(),
      },
      update: {
        // El nombre y el user agent sólo se refrescan si vienen: un poll no debe
        // borrar el nombre que puso el login.
        ...(info?.name ? { name: info.name } : {}),
        ...(info?.userAgent ? { userAgent: info.userAgent } : {}),
        ...(info?.userId ? { lastUserId: info.userId } : {}),
        lastSeenAt: new Date(),
      },
    });
    this.known.add(deviceId);
  }

  /** Efecto secundario de `GET /sync` (ARCHITECTURE.md §6.4). */
  async touch(deviceId: string, cursor: number, userId?: string): Promise<void> {
    await this.ensure(deviceId, userId ? { userId } : undefined);
    await this.prisma.device.update({
      where: { id: deviceId },
      data: { lastSeenAt: new Date(), lastCursor: cursor, ...(userId ? { lastUserId: userId } : {}) },
    });
  }

  list() {
    return this.prisma.device.findMany({ orderBy: { lastSeenAt: 'desc' }, take: 200 });
  }
}
