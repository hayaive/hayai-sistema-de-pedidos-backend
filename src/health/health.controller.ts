import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { AppError } from '../common/errors';
import { serverTime } from '../common/time';
import { Public } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
@SkipThrottle()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Healthcheck de Railway (`/api/v1/health`). **No toca la base a propósito**:
   * si el healthcheck dependiera de Postgres, una caída de la base tumbaría el
   * servicio entero y con él el endpoint que sirve para diagnosticarla.
   */
  @Public()
  @Get()
  health() {
    return { status: 'ok', serverTime: serverTime(), uptimeSeconds: Math.round(process.uptime()) };
  }

  /** Sonda de la base, para diagnóstico manual y monitoreo externo. */
  @Public()
  @Get('db')
  async db() {
    const started = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new AppError('internal_error', 'La base de datos no responde');
    }
    return { status: 'ok', latencyMs: Date.now() - started, serverTime: serverTime() };
  }
}
