import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../generated/prisma/client';
import { auditOut } from '../common/serialize';
import { Tx } from '../common/tx';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import { AuditQueryDto } from './dto/audit-query.dto';

/** Lo mínimo que hace falta para firmar un asiento de bitácora. */
export interface AuditActor {
  id: string;
  fullName?: string;
  username?: string;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Asienta en la bitácora. La tabla es append-only reforzada por trigger: un
   * rastro que se puede editar no prueba nada.
   *
   * Nunca lanza: si el asiento falla, la operación de negocio que lo provocó no
   * se deshace por eso (perder una línea de bitácora es malo, perder una venta
   * es peor). El fallo se registra en el log del servidor. Cuando el asiento
   * tiene que ser atómico con la operación —anular una venta, fusionar un
   * cliente— se pasa el `tx` y entonces sí va dentro de la transacción.
   */
  async log(
    actor: AuditActor | AuthUser,
    action: string,
    entity: string,
    entityId: string,
    data?: unknown,
    opts?: { tx?: Tx; deviceId?: string; id?: string },
  ): Promise<void> {
    const db = opts?.tx ?? this.prisma;
    try {
      await db.auditLog.create({
        data: {
          id: opts?.id ?? randomUUID(),
          userId: actor.id,
          userName: actor.fullName ?? actor.username ?? actor.id,
          action,
          entity,
          entityId,
          data: (data === undefined ? undefined : (data as Prisma.InputJsonValue)) ?? undefined,
          deviceId: opts?.deviceId ?? null,
        },
      });
    } catch (err) {
      if (opts?.tx) throw err; // dentro de una transacción ajena, el fallo es del llamador
      this.logger.error(`No se pudo asentar en bitácora (${action} ${entity} ${entityId})`, err as Error);
    }
  }

  /** `GET /audit` paginado. */
  async list(query: AuditQueryDto) {
    const where: Prisma.AuditLogWhereInput = {
      ...(query.entity ? { entity: query.entity } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return {
      page: query.page,
      pageSize: query.pageSize,
      total,
      items: rows.map(auditOut),
    };
  }
}
