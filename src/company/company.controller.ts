import { Body, Controller, Get, Header, Patch, Res } from '@nestjs/common';
import { Response } from 'express';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { IfMatch } from '../common/if-match';
import { CompanyService } from './company.service';
import { UpdateCompanyDto } from './dto/update-company.dto';

@Controller('company')
export class CompanyController {
  constructor(private readonly company: CompanyService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async get(@Res({ passthrough: true }) res: Response) {
    const out = await this.company.get();
    res.setHeader('ETag', String(out.rev));
    return out;
  }

  /** `If-Match` obligatorio: ver §6.7. */
  @Patch()
  @RequirePermission('manage_settings')
  async update(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateCompanyDto,
    @IfMatch() ifMatch: number | null,
    @Res({ passthrough: true }) res: Response,
  ) {
    const out = await this.company.update(user, dto, ifMatch);
    res.setHeader('ETag', String(out.rev));
    return out;
  }
}
