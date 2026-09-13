import { Injectable, Logger } from '@nestjs/common';
import { MutationStatus } from '../generated/prisma/enums';
import { Prisma } from '../generated/prisma/client';
import { AppError, ErrorCode } from '../common/errors';
import { clampClientTime, parseDate, serverTime } from '../common/time';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/auth.types';
import { DevicesService } from '../devices/devices.service';
import { PrismaService } from '../prisma/prisma.service';
import { CursorService } from './cursor.service';
import { MutationDto, PushSyncDto } from './dto/sync.dto';
import { MutationRegistry } from './mutations/registry';
import { HandlerOutcome, MutationResult, MutationStatusName } from './sync.types';

/**
 * Códigos que son **rechazos permanentes**: el cliente saca la mutación de la cola
 * y avisa al usuario, sin reintentar nunca (ARCHITECTURE.md §5, "Retryable vs
 * permanente"). Todo lo que no esté aquí y no sea un conflicto se considera
 * transitorio y el cliente reintenta con el mismo `mutationId`.
 */
const PERMANENT: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'validation_failed',
  'not_found',
  'forbidden',
  'terminal_state',
  'order_already_billed',
  'online_only',
  'already_closed',
  'dependency_failed',
  'retired_code',
  'has_history',
  'has_deposits',
  'unauthorized',
]);

@Injectable()
export class PushService {
  private readonly log = new Logger('Sync');

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: MutationRegistry,
    private readonly cursor: CursorService,
    private readonly devices: DevicesService,
    private readonly audit: AuditService,
  ) {}

  /**
   * `POST /sync` (§6.5).
   *
   * Las mutaciones se aplican **en orden y cada una en su propia transacción**: una
   * mutación mala no bloquea la cola. Si una depende de una entidad que falló, sale
   * `rejected` con `dependency_failed` en lugar de estrellarse contra una FK.
   */
  async push(user: AuthUser, deviceId: string, dto: PushSyncDto) {
    const results: MutationResult[] = [];

    /** Ids de entidades cuya mutación falló en ESTE lote. */
    const failed = new Set<string>();

    for (const mutation of dto.mutations) {
      const result = await this.applyOne(user, deviceId, mutation, failed);
      results.push(result);

      if (result.status === 'rejected' || result.status === 'conflict') {
        // Lo que esta mutación quería crear no existe: lo que dependa de ello no
        // debe intentarse.
        const declared = declaredId(mutation);
        if (declared) failed.add(declared);
        if (result.entityId) failed.add(result.entityId);
      }
    }

    const cursor = await this.cursor.current();
    await this.devices.touch(deviceId, dto.cursor ?? cursor, user.id);

    return { cursor, serverTime: serverTime(), results };
  }

  private async applyOne(
    user: AuthUser,
    deviceId: string,
    mutation: MutationDto,
    failed: Set<string>,
  ): Promise<MutationResult> {
    const { mutationId, entity, op } = mutation;

    // ── 1 · Idempotencia (§4.5) ────────────────────────────────────────────────
    // Si la red murió después del commit, el reenvío devuelve el resultado
    // guardado sin re-aplicar. Sin esto, un abono o una venta se duplican con sólo
    // perder la respuesta.
    const recorded = await this.prisma.syncMutation.findUnique({ where: { id: mutationId } });
    if (recorded) {
      const stored = (recorded.result ?? {}) as Partial<MutationResult>;
      return {
        mutationId,
        // Una mutación que ya se aplicó se reporta como `duplicate`; un conflicto o
        // un rechazo guardados se devuelven tal cual, porque siguen siendo ciertos.
        status: recorded.status === 'applied' ? 'duplicate' : (recorded.status as MutationStatusName),
        entityId: recorded.entityId || undefined,
        serverEntity: stored.serverEntity,
        idMap: stored.idMap,
        renumbered: stored.renumbered,
        reason: recorded.rejectReason ?? stored.reason ?? undefined,
        retryable: false,
      };
    }

    const rawClientAt = parseDate(mutation.at);
    const clamped = clampClientTime(mutation.at);

    // ── 2 · Dependencias fallidas ──────────────────────────────────────────────
    const blocking = dependencies(mutation).find((id) => failed.has(id));
    if (blocking) {
      return this.finish(user, deviceId, mutation, clamped.at, rawClientAt, {
        status: 'rejected',
        reason: `dependency_failed: ${blocking}`,
      });
    }

    // ── 3 · Usuario desactivado con cola pendiente (§5) ────────────────────────
    // Se acepta si el timestamp de cliente (acotado) es anterior a la revocación:
    // esas mutaciones son hechos de negocio que ya ocurrieron y descartarlas sería
    // perder dinero del registro. Lo que no se permite es seguir operando después.
    if (!user.active) {
      const cutoff = user.deactivatedAt;
      const beforeRevocation = cutoff ? clamped.at.getTime() < cutoff.getTime() : false;

      await this.audit.log(
        user,
        beforeRevocation ? 'cola_usuario_revocado_aceptada' : 'cola_usuario_revocado_rechazada',
        entity,
        mutationId,
        { clientAt: clamped.at.toISOString(), deactivatedAt: cutoff?.toISOString() },
      );

      if (!beforeRevocation) {
        return this.finish(user, deviceId, mutation, clamped.at, rawClientAt, {
          status: 'rejected',
          reason: 'user_deactivated: la mutación es posterior a la revocación del usuario',
        });
      }
    }

    if (clamped.clamped) {
      // El reloj del dispositivo está mal puesto: se acota y se deja constancia,
      // porque una fecha torcida envenena el día contable (§4.6).
      this.log.warn(
        `Reloj del dispositivo ${deviceId} desviado: ${mutation.at} acotado a ${clamped.at.toISOString()}`,
      );
    }

    // ── 4 · Aplicar, en su propia transacción ──────────────────────────────────
    try {
      const handler = this.registry.resolve(entity, op);

      const outcome = await this.prisma.$transaction(
        (tx) =>
          handler({
            tx,
            user,
            deviceId,
            clientAt: clamped.at,
            rawClientAt,
            baseRev: mutation.baseRev ?? null,
            payload: mutation.payload ?? {},
            offline: mutation.offline ?? true,
          }),
        { timeout: 20_000 },
      );

      return this.finish(user, deviceId, mutation, clamped.at, rawClientAt, outcome);
    } catch (err) {
      return this.fail(user, deviceId, mutation, clamped.at, rawClientAt, err);
    }
  }

  /** Guarda el resultado en la bitácora de idempotencia y lo devuelve. */
  private async finish(
    user: AuthUser,
    deviceId: string,
    mutation: MutationDto,
    clientAt: Date,
    rawClientAt: Date | null,
    outcome: HandlerOutcome,
  ): Promise<MutationResult> {
    const result: MutationResult = {
      mutationId: mutation.mutationId,
      status: outcome.status,
      entityId: outcome.entityId,
      serverEntity: outcome.serverEntity,
      idMap: outcome.idMap,
      renumbered: outcome.renumbered,
      reason: outcome.reason,
      // `applied`, `duplicate`, `conflict` y `rejected` son todos definitivos: el
      // cliente no reintenta con el mismo `mutationId`. Un conflicto se reenvía con
      // uno NUEVO después de rebasar.
      retryable: false,
    };

    await this.record(user, deviceId, mutation, clientAt, rawClientAt, result);
    return result;
  }

  /**
   * Traduce la excepción a un resultado del contrato.
   *
   * Lo que NO se guarda en la bitácora de idempotencia es lo transitorio (un 5xx,
   * la base caída): si se guardara, el reintento del cliente recibiría el fallo
   * cacheado para siempre y la mutación se perdería.
   */
  private async fail(
    user: AuthUser,
    deviceId: string,
    mutation: MutationDto,
    clientAt: Date,
    rawClientAt: Date | null,
    err: unknown,
  ): Promise<MutationResult> {
    if (err instanceof AppError) {
      const details = (err.details ?? {}) as { serverEntity?: unknown };

      if (err.code === 'conflict') {
        const result: MutationResult = {
          mutationId: mutation.mutationId,
          status: 'conflict',
          serverEntity: details.serverEntity,
          reason: err.message,
          // Con el MISMO mutationId no: el cliente rebasa y reenvía con uno nuevo.
          retryable: false,
        };
        await this.record(user, deviceId, mutation, clientAt, rawClientAt, result);
        return result;
      }

      if (PERMANENT.has(err.code)) {
        const result: MutationResult = {
          mutationId: mutation.mutationId,
          status: 'rejected',
          serverEntity: details.serverEntity,
          reason: `${err.code}: ${err.message}`,
          retryable: false,
        };
        await this.record(user, deviceId, mutation, clientAt, rawClientAt, result);
        return result;
      }
    }

    this.log.error(
      `Mutación ${mutation.entity}.${mutation.op} (${mutation.mutationId}) falló de forma transitoria`,
      err instanceof Error ? err.stack : String(err),
    );

    return {
      mutationId: mutation.mutationId,
      status: 'rejected',
      reason: 'internal_error: el servidor no pudo aplicar la mutación',
      // Aquí sí: el cliente reintenta con el mismo `mutationId` y con backoff.
      retryable: true,
    };
  }

  private async record(
    user: AuthUser,
    deviceId: string,
    mutation: MutationDto,
    clientAt: Date,
    rawClientAt: Date | null,
    result: MutationResult,
  ): Promise<void> {
    try {
      await this.prisma.syncMutation.create({
        data: {
          id: mutation.mutationId,
          deviceId,
          userId: user.id,
          entity: mutation.entity.slice(0, 40),
          op: mutation.op.slice(0, 40),
          entityId: (result.entityId ?? '').slice(0, 64),
          status: result.status as MutationStatus,
          rejectReason: result.reason?.slice(0, 200) ?? null,
          result: {
            ...(result.serverEntity === undefined ? {} : { serverEntity: result.serverEntity }),
            ...(result.idMap ? { idMap: result.idMap } : {}),
            ...(result.renumbered ? { renumbered: result.renumbered } : {}),
            ...(result.reason ? { reason: result.reason } : {}),
          } as Prisma.InputJsonValue,
          // Se guarda el `at` CRUDO además del acotado: si un equipo tiene el reloj
          // mal, ésta es la prueba de qué mandó de verdad.
          clientAt: rawClientAt ?? clientAt,
        },
      });
    } catch (err) {
      // Dos subidas simultáneas del mismo lote pueden chocar aquí. No es un fallo
      // de la mutación (que ya está aplicada y es idempotente), así que no se
      // propaga: sólo se anota.
      this.log.warn(
        `No se pudo registrar la idempotencia de ${mutation.mutationId}: ${(err as Error).message}`,
      );
    }
  }
}

/** El id que la mutación declara para su propia entidad, si lo trae. */
function declaredId(mutation: MutationDto): string | null {
  const p = mutation.payload ?? {};
  for (const key of ['id', 'orderId', 'saleId', 'productId', 'customerId', 'depositId']) {
    const value = p[key];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

/**
 * Ids de los que depende una mutación. Se comparan contra los que fallaron en el
 * lote para poder rechazar con `dependency_failed` en lugar de dejar que salte una
 * FK con un mensaje incomprensible.
 */
function dependencies(mutation: MutationDto): string[] {
  const p = (mutation.payload ?? {}) as Record<string, unknown>;
  const out: string[] = [];

  const add = (value: unknown) => {
    if (typeof value === 'string' && value) out.push(value);
  };

  // El id propio no cuenta como dependencia en un `create`: es lo que se está
  // creando. Sí cuenta en el resto de operaciones.
  if (mutation.op !== 'create') add(p.id);

  add(p.orderId);
  add(p.customerId);
  add(p.priceGroupId);
  add(p.depositId);
  if (mutation.entity !== 'sale') add(p.saleId);
  if (mutation.entity !== 'product') add(p.productId);

  const items = p.items;
  if (Array.isArray(items)) {
    for (const item of items) {
      if (item && typeof item === 'object') add((item as Record<string, unknown>).productId);
    }
  }

  return out;
}
