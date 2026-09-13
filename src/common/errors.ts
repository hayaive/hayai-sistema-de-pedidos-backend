import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Códigos de error estables del contrato (ARCHITECTURE.md §6.1). El frontend
 * ramifica sobre ellos, así que **no se renombran**: se añaden.
 */
export type ErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'validation_failed'
  | 'not_found'
  | 'conflict'
  | 'precondition_required'
  | 'cursor_too_old'
  | 'terminal_state'
  | 'order_already_billed'
  | 'online_only'
  | 'already_closed'
  | 'dependency_failed'
  | 'retired_code'
  | 'has_history'
  | 'has_deposits'
  | 'internal_error';

const STATUS: Record<ErrorCode, HttpStatus> = {
  unauthorized: HttpStatus.UNAUTHORIZED,
  forbidden: HttpStatus.FORBIDDEN,
  validation_failed: HttpStatus.BAD_REQUEST,
  not_found: HttpStatus.NOT_FOUND,
  conflict: HttpStatus.CONFLICT,
  precondition_required: HttpStatus.PRECONDITION_REQUIRED,
  cursor_too_old: HttpStatus.GONE,
  terminal_state: HttpStatus.CONFLICT,
  order_already_billed: HttpStatus.CONFLICT,
  online_only: HttpStatus.FORBIDDEN,
  already_closed: HttpStatus.CONFLICT,
  dependency_failed: HttpStatus.CONFLICT,
  retired_code: HttpStatus.CONFLICT,
  has_history: HttpStatus.CONFLICT,
  has_deposits: HttpStatus.CONFLICT,
  internal_error: HttpStatus.INTERNAL_SERVER_ERROR,
};

/**
 * Error de dominio con código del contrato. `details` viaja tal cual al cliente,
 * así que ahí van datos de negocio (el estado del servidor en un conflicto), no
 * trazas ni mensajes de Postgres.
 */
export class AppError extends HttpException {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super({ error: { code, message, ...(details === undefined ? {} : { details }) } }, STATUS[code]);
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what: string) => new AppError('not_found', `${what} no existe`);
export const invalid = (message: string, details?: unknown) =>
  new AppError('validation_failed', message, details);
