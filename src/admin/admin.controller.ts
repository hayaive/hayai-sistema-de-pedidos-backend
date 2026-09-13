import { Body, Controller, Post } from '@nestjs/common';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { AdminService } from './admin.service';
import { ImportStateDto } from './dto/import.dto';

@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  /** Qué haría la importación, sin escribir nada. */
  @Post('import/dry-run')
  @RequirePermission('manage_settings')
  dryRun(@Body() dto: ImportStateDto) {
    return this.admin.dryRun(dto);
  }

  /**
   * Importación inicial del `AppState` (§8). Una sola vez, idempotente por id, y
   * exige `manage_settings`: reescribe el catálogo del negocio entero.
   */
  @Post('import')
  @RequirePermission('manage_settings')
  importState(@CurrentUser() user: AuthUser, @Body() dto: ImportStateDto) {
    return this.admin.importState(user, dto);
  }
}
