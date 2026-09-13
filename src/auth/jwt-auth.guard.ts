import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { AppError } from '../common/errors';
import { DevicesService } from '../devices/devices.service';
import { RequestWithAuth } from './auth.types';
import { IS_PUBLIC } from './decorators';

/**
 * Guardia global: todo exige `Authorization: Bearer` salvo lo marcado con
 * `@Public()`. Además exige `X-Device-Id` en todo lo autenticado
 * (ARCHITECTURE.md §6.1) y garantiza la fila del dispositivo, porque hay FKs
 * (`sales.device_id`, `order_deposits.device_id`…) que la referencian.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private readonly reflector: Reflector,
    private readonly devices: DevicesService,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    await super.canActivate(context);

    const req = context.switchToHttp().getRequest<RequestWithAuth>();
    const deviceId = headerValue(req, 'x-device-id');
    if (!deviceId) {
      throw new AppError(
        'validation_failed',
        'Falta la cabecera X-Device-Id: toda petición autenticada declara su dispositivo',
      );
    }
    if (deviceId.length > 64) {
      throw new AppError('validation_failed', 'X-Device-Id no puede pasar de 64 caracteres');
    }

    req.deviceId = deviceId;
    await this.devices.ensure(deviceId, {
      userAgent: headerValue(req, 'user-agent') ?? undefined,
      userId: req.user?.id,
    });

    return true;
  }

  /** Traduce el 401 de passport al formato del contrato. */
  handleRequest<TUser>(err: unknown, user: TUser): TUser {
    if (err) throw err;
    if (!user) throw new AppError('unauthorized', 'Falta un access token válido');
    return user;
  }
}

function headerValue(req: RequestWithAuth, name: string): string | null {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && String(value).trim() ? String(value).trim() : null;
}
