import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Permission } from '../generated/prisma/enums';
import { AppError } from '../common/errors';
import { RequestWithAuth } from './auth.types';
import { IS_PUBLIC, REQUIRED_PERMISSIONS } from './decorators';

/**
 * Aplica `@RequirePermission()`. Los permisos del frontend son sólo UX: la
 * decisión está aquí (ARCHITECTURE.md §6.1).
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return true;
    }

    const required = this.reflector.getAllAndOverride<Permission[]>(REQUIRED_PERMISSIONS, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;

    const req = context.switchToHttp().getRequest<RequestWithAuth>();
    const held = new Set(req.user?.permissions ?? []);
    if (required.some((p) => held.has(p))) return true;

    throw new AppError('forbidden', `Hace falta el permiso: ${required.join(' o ')}`);
  }
}
