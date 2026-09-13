import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { closureOut } from '../common/serialize';
import { ClosuresService } from './closures.service';
import { ClosuresQueryDto, CreateClosureDto, DraftQueryDto } from './dto/closure.dto';

@Controller('closures')
export class ClosuresController {
  constructor(private readonly closures: ClosuresService) {}

  @Get()
  @RequirePermission('close_cash', 'view_sales')
  list(@Query() query: ClosuresQueryDto) {
    return this.closures.list(query);
  }

  /**
   * Borrador autoritativo del cierre. El cálculo local del frontend sigue
   * sirviendo sin red, pero **el bueno es éste**: es el único que ve todos los
   * dispositivos.
   */
  @Get('draft')
  @RequirePermission('close_cash')
  draft(@Query() query: DraftQueryDto) {
    return this.closures.draft(query.date);
  }

  @Get(':id')
  @RequirePermission('close_cash', 'view_sales')
  getOne(@Param('id') id: string) {
    return this.closures.getOne(id);
  }

  /** Un cierre por día: si ya existe, gana el primero y se devuelve el existente. */
  @Post()
  @RequirePermission('close_cash')
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateClosureDto) {
    const { closure, alreadyClosed } = await this.closures.create(user, dto);
    if (alreadyClosed) throw ClosuresService.alreadyClosed(closure);
    return closureOut(closure);
  }
}
