import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { RatesService } from './rates.service';
import { CreateRateDto, RatesQueryDto } from './dto/rate.dto';

@Controller('rates')
export class RatesController {
  constructor(private readonly rates: RatesService) {}

  /** Log completo, paginado: la tasa es un histórico, no un valor. */
  @Get()
  list(@Query() query: RatesQueryDto) {
    return this.rates.list(query);
  }

  /** Las vigentes de las tres fuentes. Sin permiso: cobrar necesita la tasa. */
  @Get('current')
  current() {
    return this.rates.currentAll();
  }

  @Post()
  @RequirePermission('manage_exchange_rates')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateRateDto) {
    return this.rates.create(user, dto);
  }

  /** Trae la tasa oficial desde el servidor (§6.6), no desde el navegador. */
  @Post('fetch')
  @RequirePermission('manage_exchange_rates')
  fetch(@CurrentUser() user: AuthUser) {
    return this.rates.fetchFromApi(user);
  }
}
