import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { IfMatch } from '../common/if-match';
import { customerOut } from '../common/serialize';
import { CustomersService } from './customers.service';
import { CreateCustomerDto, CustomersQueryDto, UpdateCustomerDto } from './dto/customer.dto';

@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @RequirePermission('view_customers')
  list(@Query() query: CustomersQueryDto) {
    return this.customers.list(query);
  }

  @Get(':id')
  @RequirePermission('view_customers')
  getOne(@Param('id') id: string) {
    return this.customers.getOne(id);
  }

  /**
   * Un alta con cédula ya existente **se fusiona** y la respuesta trae `idMap`
   * para que el cliente reapunte lo que tenía apuntado al id local.
   */
  @Post()
  @RequirePermission('edit_customers')
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateCustomerDto) {
    const { customer, merged, idMap } = await this.customers.create(user, dto);
    return { ...customerOut(customer), merged, ...(idMap ? { idMap } : {}) };
  }

  @Patch(':id')
  @RequirePermission('edit_customers')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateCustomerDto,
    @IfMatch() ifMatch: number | null,
    @Res({ passthrough: true }) res: Response,
  ) {
    const customer = await this.customers.update(user, id, dto, { ifMatch });
    res.setHeader('ETag', String(customer.rev));
    return customerOut(customer);
  }

  @Delete(':id')
  @RequirePermission('edit_customers')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<void> {
    await this.customers.remove(user, id);
  }
}
