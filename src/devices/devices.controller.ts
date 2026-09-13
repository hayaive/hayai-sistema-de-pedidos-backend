import { Controller, Get } from '@nestjs/common';
import { RequirePermission } from '../auth/decorators';
import { deviceOut } from '../common/serialize';
import { DevicesService } from './devices.service';

@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  /**
   * Para diagnosticar "este equipo no sincroniza desde el martes": `lastSeenAt` y
   * `lastCursor` los actualiza `GET /sync`.
   */
  @Get()
  @RequirePermission('manage_settings', 'manage_users')
  async list() {
    const rows = await this.devices.list();
    return rows.map(deviceOut);
  }
}
