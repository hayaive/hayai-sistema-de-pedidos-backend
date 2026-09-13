import { Controller, Get, Query } from '@nestjs/common';
import { RequirePermission } from '../auth/decorators';
import { AuditService } from './audit.service';
import { AuditQueryDto } from './dto/audit-query.dto';

@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /** La bitácora completa vive en el servidor; al cliente sólo le viaja la cola. */
  @Get()
  @RequirePermission('manage_settings', 'manage_users')
  list(@Query() query: AuditQueryDto) {
    return this.audit.list(query);
  }
}
