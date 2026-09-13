import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { Permission } from '../generated/prisma/enums';
import { AppError } from '../common/errors';
import { AuthUser, RequestWithAuth } from './auth.types';

export const IS_PUBLIC = 'auth:public';
export const REQUIRED_PERMISSIONS = 'auth:permissions';

/** Ruta sin autenticación (login, refresh, health). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * Permisos exigidos por la ruta. Se aplican **en el servidor**: los del frontend
 * son sólo UX (ARCHITECTURE.md §6.1). Varios permisos = hace falta cualquiera de
 * ellos (el frontend ya modela el acceso así: "ver o editar").
 */
export const RequirePermission = (...permissions: Permission[]) =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest<RequestWithAuth>();
  if (!req.user) throw new AppError('unauthorized', 'Sesión no válida');
  return req.user;
});

/** El `X-Device-Id` de la petición, ya garantizado en la tabla `devices`. */
export const DeviceId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<RequestWithAuth>();
  if (!req.deviceId) throw new AppError('validation_failed', 'Falta la cabecera X-Device-Id');
  return req.deviceId;
});
