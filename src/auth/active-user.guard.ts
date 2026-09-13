import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '../common/errors';
import { RequestWithAuth } from './auth.types';
import { IS_PUBLIC } from './decorators';

export const ALLOW_DEACTIVATED = 'auth:allow-deactivated';

/**
 * Marca la única ruta que admite a un usuario desactivado: `POST /sync`.
 *
 * Razón (ARCHITECTURE.md §5): las mutaciones que ese usuario creó antes de la
 * revocación son hechos de negocio que ya ocurrieron —una venta, dinero que
 * entró— y descartarlas sería perder dinero del registro. Lo que no se permite es
 * que siga operando después de la revocación, y de eso se encarga el propio
 * `POST /sync`, que compara el timestamp de cada mutación con `deactivatedAt`.
 */
export const AllowDeactivated = () => SetMetadata(ALLOW_DEACTIVATED, true);

@Injectable()
export class ActiveUserGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest<RequestWithAuth>();
    if (!req.user || req.user.active) return true;

    if (this.reflector.getAllAndOverride<boolean>(ALLOW_DEACTIVATED, targets)) return true;

    throw new AppError('unauthorized', 'El usuario está desactivado');
  }
}
