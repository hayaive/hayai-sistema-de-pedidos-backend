import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AppConfig } from '../config/app-config';
import { AppError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { AccessTokenPayload, AuthUser } from './auth.types';

/**
 * Valida el access token y resuelve el usuario **desde la base en cada
 * petición**, en lugar de confiar en los permisos que trae el token.
 *
 * Es un SELECT por request y vale la pena: si los permisos viajaran dentro del
 * JWT, revocar un permiso o desactivar a un cajero no surtiría efecto hasta que
 * caduque su token (15 min operando con permisos que ya se le quitaron).
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    cfg: AppConfig,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: cfg.jwtAccessSecret,
    });
  }

  async validate(payload: AccessTokenPayload): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: { role: { include: { permissions: true } } },
    });

    if (!user) throw new AppError('unauthorized', 'El usuario de la sesión ya no existe');
    if (user.system) throw new AppError('unauthorized', 'El usuario técnico no inicia sesión');

    // Un usuario desactivado NO se rechaza aquí: lo hace `ActiveUserGuard`, que sí
    // sabe qué ruta se está pidiendo. La única que lo admite es `POST /sync`, para
    // que pueda entregar la cola que creó antes de la revocación (§5).
    return {
      id: user.id,
      username: user.username,
      fullName: user.fullName,
      roleId: user.roleId,
      permissions: user.role.permissions.map((p) => p.permission),
      active: user.active,
      deactivatedAt: user.deactivatedAt,
    };
  }
}
