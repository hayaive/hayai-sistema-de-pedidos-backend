import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { AuthUser } from '../auth/auth.types';
import { AllowDeactivated } from '../auth/active-user.guard';
import { CurrentUser, DeviceId } from '../auth/decorators';
import { BootstrapService } from './bootstrap.service';
import { DeltaService } from './delta.service';
import { PushService } from './push.service';
import { DevicesService } from '../devices/devices.service';
import { PushSyncDto, SyncQueryDto } from './dto/sync.dto';
import { MutationRegistry } from './mutations/registry';

@Controller('bootstrap')
export class BootstrapController {
  constructor(private readonly bootstrap: BootstrapService) {}

  /**
   * Estado completo de la ventana operativa (§6.3). Se pide al iniciar sesión o
   * cuando el cursor caducó, no en cada arranque: para ponerse al día está
   * `GET /sync`.
   */
  @Get()
  build() {
    return this.bootstrap.build();
  }
}

@Controller('sync')
@SkipThrottle()
export class SyncController {
  constructor(
    private readonly delta: DeltaService,
    private readonly push: PushService,
    private readonly devices: DevicesService,
    private readonly registry: MutationRegistry,
  ) {}

  /**
   * Delta desde un cursor (§6.4). El cliente lo llama cada ~60 s; no hay
   * websockets, y el mismo mecanismo sirve para ponerse al día tras reconectar y
   * para ver los cambios de otro dispositivo estando en línea.
   *
   * Se excluye del límite de peticiones: es un poll periódico y legítimo, y
   * estrangularlo dejaría a los equipos sin sincronizar justo cuando hay trabajo.
   */
  @Get()
  async get(
    @Query() query: SyncQueryDto,
    @CurrentUser() user: AuthUser,
    @DeviceId() deviceId: string,
  ) {
    const result = await this.delta.delta(query.since, query.limit);
    // Efecto secundario documentado del §6.4: así se diagnostica "este equipo no
    // sincroniza desde el martes".
    await this.devices.touch(deviceId, result.cursor, user.id);
    return result;
  }

  /**
   * Sube la cola de mutaciones. También se usa en línea: el camino de escritura es
   * **uno solo**, con o sin red (§4.1), de modo que el modo offline no es un camino
   * raro que casi nunca se ejerce.
   *
   * Admite a un usuario ya desactivado para que pueda entregar lo que hizo antes de
   * la revocación; cada mutación se compara contra `deactivatedAt` (§5).
   */
  @Post()
  @AllowDeactivated()
  push_(
    @Body() dto: PushSyncDto,
    @CurrentUser() user: AuthUser,
    @DeviceId() deviceId: string,
  ) {
    return this.push.push(user, dto.deviceId ?? deviceId, dto);
  }

  /** Las operaciones que este servidor entiende. Útil para diagnosticar versiones. */
  @Get('operations')
  operations() {
    return { operations: this.registry.supported() };
  }
}
