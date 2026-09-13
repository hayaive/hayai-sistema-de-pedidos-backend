import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AppError } from '../common/errors';
import { serverTime } from '../common/time';
import { Tx } from '../common/tx';
import { AppConfig } from '../config/app-config';
import { DevicesService } from '../devices/devices.service';
import { PrismaService } from '../prisma/prisma.service';
import { CursorService } from '../sync/cursor.service';
import { AccessTokenPayload, AuthUser } from './auth.types';
import { LoginDto } from './dto/login.dto';

/**
 * Parámetros de argon2id. Los valores son los recomendados de OWASP para un
 * servicio interactivo: 19 MiB y 2 iteraciones dan ~50 ms por hash en hardware
 * modesto, que es lo que se quiere en un login (rápido para el cajero, caro para
 * quien pruebe un diccionario).
 */
export const ARGON2_OPTIONS: argon2.HashOptions & { raw?: false } = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

export const hashPassword = (plain: string): Promise<string> =>
  argon2.hash(plain, ARGON2_OPTIONS);

/** El hash nunca sale del servidor, y su comparación nunca cortocircuita. */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    // Un hash con formato inválido (como el literal '!no-login!' del usuario
    // técnico) no es un error del sistema: es una contraseña que no coincide.
    return false;
  }
}

export interface TokenPair {
  accessToken: string;
  accessExpiresIn: number;
  refreshToken: string;
  refreshExpiresAt: string;
}

@Injectable()
export class AuthService {
  private readonly log = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly cfg: AppConfig,
    private readonly devices: DevicesService,
    private readonly cursor: CursorService,
  ) {}

  async login(dto: LoginDto) {
    const username = dto.username.trim().toLowerCase();

    const user = await this.prisma.user.findUnique({
      where: { username },
      include: { role: { include: { permissions: true } } },
    });

    // Mismo mensaje para "no existe" y "contraseña mala": distinguirlos regala
    // un enumerador de usuarios. Y se verifica el hash igual cuando el usuario no
    // existe, para no filtrar por tiempo de respuesta quién está registrado.
    const fallbackHash = await this.dummyHash();
    const ok = await verifyPassword(user?.passwordHash ?? fallbackHash, dto.password);

    if (!user || !ok) throw new AppError('unauthorized', 'Usuario o contraseña incorrectos');
    if (user.system) throw new AppError('unauthorized', 'El usuario técnico no puede iniciar sesión');
    if (!user.active) throw new AppError('unauthorized', 'El usuario está desactivado');

    await this.devices.ensure(dto.device.id, {
      name: dto.device.name,
      userAgent: dto.device.userAgent,
      userId: user.id,
    });

    const tokens = await this.issueTokens(
      { id: user.id, username: user.username, roleId: user.roleId },
      dto.device.id,
    );

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const company = await this.prisma.companySettings.findUnique({ where: { id: 'singleton' } });

    return {
      ...tokens,
      user: {
        id: user.id,
        username: user.username,
        fullName: user.fullName,
        email: user.email ?? undefined,
        roleId: user.roleId,
        active: user.active,
      },
      permissions: user.role.permissions.map((p) => p.permission),
      cursor: await this.cursor.current(),
      serverTime: serverTime(),
      schemaVersion: company?.schemaVersion ?? 3,
      offlineSessionMaxDays: this.cfg.offlineSessionMaxDays,
    };
  }

  /**
   * Rotación con detección de reutilización. Si llega un refresh token que ya
   * fue canjeado, se asume que la cadena está comprometida (alguien copió el
   * token) y se revocan **todas** las sesiones de ese usuario.
   */
  async refresh(refreshToken: string, deviceId?: string) {
    const tokenHash = hashToken(refreshToken);

    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: { include: { role: { include: { permissions: true } } } } },
    });

    if (!existing) throw new AppError('unauthorized', 'Refresh token no válido');

    if (existing.revokedAt) {
      this.log.warn(
        `Reutilización de refresh token del usuario ${existing.userId}: se revocan sus sesiones`,
      );
      await this.prisma.refreshToken.updateMany({
        where: { userId: existing.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new AppError('unauthorized', 'Refresh token ya utilizado: vuelve a iniciar sesión');
    }

    if (existing.expiresAt.getTime() <= Date.now()) {
      throw new AppError('unauthorized', 'Refresh token caducado');
    }

    const user = existing.user;
    if (user.system || !user.active) {
      await this.prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new AppError('unauthorized', 'El usuario está desactivado');
    }

    const device = deviceId ?? existing.deviceId ?? undefined;
    if (device) await this.devices.ensure(device, { userId: user.id });

    // Se revoca la vieja y se emite la nueva en la misma transacción: si se
    // cayera entre las dos, el cliente se quedaría sin sesión utilizable.
    const tokens = await this.prisma.$transaction(async (tx) => {
      await tx.refreshToken.update({
        where: { id: existing.id },
        data: { revokedAt: new Date(), lastUsedAt: new Date() },
      });
      return this.issueTokens(
        { id: user.id, username: user.username, roleId: user.roleId },
        device,
        tx,
      );
    });

    return {
      ...tokens,
      user: {
        id: user.id,
        username: user.username,
        fullName: user.fullName,
        email: user.email ?? undefined,
        roleId: user.roleId,
        active: user.active,
      },
      permissions: user.role.permissions.map((p) => p.permission),
      cursor: await this.cursor.current(),
      serverTime: serverTime(),
    };
  }

  /** Logout idempotente: un token desconocido o ya revocado también da 204. */
  async logout(refreshToken: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: hashToken(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async me(user: AuthUser) {
    return { user, permissions: user.permissions, serverTime: serverTime() };
  }

  private async issueTokens(
    user: { id: string; username: string; roleId: string },
    deviceId?: string,
    tx?: Tx,
  ): Promise<TokenPair> {
    const payload: AccessTokenPayload = {
      sub: user.id,
      username: user.username,
      roleId: user.roleId,
    };

    // `expiresIn` va en segundos, no como "15m": la firma tipada de @nestjs/jwt
    // sólo admite literales de tiempo concretos, y un número evita depender de eso.
    const accessTtlSeconds = Math.floor(parseTtlMs(this.cfg.jwtAccessTtl) / 1000);
    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.cfg.jwtAccessSecret,
      expiresIn: accessTtlSeconds,
    });

    // El refresh token es aleatorio, no un JWT: así se puede revocar de verdad
    // (lo que vive en la base es su hash, nunca el token).
    const refreshToken = randomBytes(48).toString('base64url');
    const expiresAt = new Date(Date.now() + parseTtlMs(this.cfg.jwtRefreshTtl));

    await (tx ?? this.prisma).refreshToken.create({
      data: {
        id: randomUUID(),
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        deviceId: deviceId ?? null,
        expiresAt,
      },
    });

    return {
      accessToken,
      accessExpiresIn: accessTtlSeconds,
      refreshToken,
      refreshExpiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Hash de referencia para gastar el mismo tiempo cuando el usuario no existe.
   * Se calcula una vez por proceso.
   */
  private dummyHashPromise?: Promise<string>;
  private dummyHash(): Promise<string> {
    if (!this.dummyHashPromise) {
      this.dummyHashPromise = hashPassword(randomBytes(24).toString('hex'));
    }
    return this.dummyHashPromise;
  }
}

/** SHA-256 hex. El refresh token es aleatorio de 384 bits: no hace falta sal. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** "15m" · "30d" · "3600" (segundos) → milisegundos. */
export function parseTtlMs(ttl: string): number {
  const m = /^(\d+)\s*([smhd])?$/.exec(ttl.trim());
  if (!m) throw new Error(`TTL no válido: ${ttl}`);
  const value = Number(m[1]);
  switch (m[2]) {
    case 'm':
      return value * 60_000;
    case 'h':
      return value * 3_600_000;
    case 'd':
      return value * 86_400_000;
    case 's':
    default:
      return value * 1000;
  }
}
