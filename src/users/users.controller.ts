import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { UsersService } from './users.service';
import {
  CreateRoleDto,
  CreateUserDto,
  SetPasswordDto,
  UpdateRoleDto,
  UpdateUserDto,
} from './dto/user.dto';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermission('manage_users')
  list() {
    return this.users.listUsers();
  }

  @Post()
  @RequirePermission('manage_users')
  create(@CurrentUser() actor: AuthUser, @Body() dto: CreateUserDto) {
    return this.users.createUser(actor, dto);
  }

  @Patch(':id')
  @RequirePermission('manage_users')
  update(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.users.updateUser(actor, id, dto);
  }

  /** Cambiar la contraseña revoca las sesiones abiertas de ese usuario. */
  @Post(':id/password')
  @RequirePermission('manage_users')
  setPassword(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() dto: SetPasswordDto,
  ) {
    return this.users.setPassword(actor, id, dto);
  }
}

@Controller('roles')
export class RolesController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list() {
    return this.users.listRoles();
  }

  @Post()
  @RequirePermission('manage_users')
  create(@CurrentUser() actor: AuthUser, @Body() dto: CreateRoleDto) {
    return this.users.createRole(actor, dto);
  }

  @Patch(':id')
  @RequirePermission('manage_users')
  update(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() dto: UpdateRoleDto) {
    return this.users.updateRole(actor, id, dto);
  }

  @Delete(':id')
  @RequirePermission('manage_users')
  @HttpCode(204)
  async remove(@CurrentUser() actor: AuthUser, @Param('id') id: string): Promise<void> {
    await this.users.removeRole(actor, id);
  }
}
