import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { ErrorCode } from './errors';

const STATUS_OF: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  validation_failed: 400,
  not_found: 404,
  conflict: 409,
  precondition_required: 428,
  cursor_too_old: 410,
  terminal_state: 409,
  order_already_billed: 409,
  online_only: 403,
  already_closed: 409,
  dependency_failed: 409,
  retired_code: 409,
  has_history: 409,
  has_deposits: 409,
  internal_error: 500,
};

/**
 * Único formateador de errores: todo sale como
 * `{ error: { code, message, details? } }` (ARCHITECTURE.md §6.1).
 *
 * Traduce además los errores de Postgres que sí son del dominio (único, FK,
 * CHECK y las excepciones que lanzan los triggers de la migración) a códigos del
 * contrato. Lo que no se reconoce sale como `internal_error` con un mensaje
 * genérico: los mensajes de Postgres pueden filtrar nombres de columnas y
 * valores de otras filas.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger('Http');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<{ method?: string; url?: string }>();

    const { status, body } = translate(exception);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.log.error(
        `${req?.method ?? '?'} ${req?.url ?? '?'} -> ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    res.status(status).json(body);
  }
}

function translate(exception: unknown): { status: number; body: unknown } {
  if (exception instanceof HttpException) {
    const raw = exception.getResponse();
    const status = exception.getStatus();

    // Ya viene con la forma del contrato (AppError).
    if (raw && typeof raw === 'object' && 'error' in raw) {
      return { status, body: raw };
    }

    // Excepciones de Nest (ValidationPipe, 404 de ruta, guards...).
    const detail = raw as { message?: unknown } | undefined;
    const list = Array.isArray(detail?.message) ? (detail?.message as string[]) : undefined;
    const message = list
      ? list.join('; ')
      : typeof detail?.message === 'string'
        ? detail.message
        : exception.message;
    return {
      status,
      body: {
        error: { code: codeForStatus(status), message, ...(list ? { details: list } : {}) },
      },
    };
  }

  const pg = pgErrorResponse(exception);
  if (pg) return pg;

  return {
    status: 500,
    body: { error: { code: 'internal_error', message: 'Error interno del servidor' } },
  };
}

function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 428:
      return 'precondition_required';
    case 410:
      return 'cursor_too_old';
    default:
      return status >= 500 ? 'internal_error' : 'validation_failed';
  }
}

/** Traduce un error de la base a un código del contrato, o null si no aplica. */
export function pgErrorResponse(exception: unknown): { status: number; body: unknown } | null {
  const sqlstate = pgCode(exception);
  if (!sqlstate) return null;

  const message = exception instanceof Error ? exception.message : '';
  const as = (code: ErrorCode, text: string) => ({
    status: STATUS_OF[code],
    body: { error: { code, message: text } },
  });

  switch (sqlstate) {
    case '23505': // unique_violation
    case '23P01': // exclusion_violation
      return as('conflict', 'La operación choca con un registro existente');
    case '23503': // foreign_key_violation
      return as('validation_failed', 'La operación referencia un registro que no existe');
    case '23502': // not_null_violation
      return as('validation_failed', 'Falta un campo obligatorio');
    case '23514': // check_violation
      return as('validation_failed', 'La operación viola una regla de integridad de la base');
    case 'P0001': // RAISE EXCEPTION de los triggers del DDL a mano
      if (/append-only/i.test(message))
        return as('validation_failed', 'El registro es append-only: corrige con un asiento nuevo');
      if (/retirado/i.test(message))
        return as('retired_code', 'El código está retirado y no se puede reutilizar');
      return as('validation_failed', 'Regla de negocio violada por la base de datos');
    default:
      return null;
  }
}

/**
 * Saca el SQLSTATE de un error, venga de `pg` directamente o envuelto por
 * Prisma. Prisma traduce algunas violaciones a sus propios códigos (P2002,
 * P2003…) y propaga el error del driver en `cause` para el resto.
 */
export function pgCode(exception: unknown): string | null {
  const seen = new Set<unknown>();
  let cur: unknown = exception;
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    const e = cur as { code?: unknown; cause?: unknown };
    if (typeof e.code === 'string') {
      if (e.code === 'P2002') return '23505';
      if (e.code === 'P2003') return '23503';
      if (e.code === 'P2004') return '23514';
      if (/^[0-9A-Z]{5}$/.test(e.code)) return e.code;
    }
    cur = e.cause;
  }
  return null;
}

/** true si el error es una violación de índice único (choque de clave natural). */
export function isUniqueViolation(exception: unknown): boolean {
  return pgCode(exception) === '23505';
}
