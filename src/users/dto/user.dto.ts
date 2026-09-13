import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Permission } from '../../generated/prisma/enums';

export const ALL_PERMISSIONS: Permission[] = [
  'view_sales',
  'create_sale',
  'edit_sale',
  'cancel_sale',
  'view_inventory',
  'edit_inventory',
  'view_customers',
  'edit_customers',
  'view_orders',
  'edit_orders',
  'process_orders',
  'close_cash',
  'manage_users',
  'manage_settings',
  'manage_exchange_rates',
];

/**
 * Mínimo de contraseña. No se piden símbolos obligatorios a propósito: las reglas
 * de composición empujan a la gente a `Cajero1!` y a pegar la clave en el monitor.
 * Lo que cuesta es la longitud.
 */
const PASSWORD_MIN = 10;

export class CreateUserDto {
  @IsOptional() @IsString() @MaxLength(64) id?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  @Matches(/^[a-zA-Z0-9._-]+$/, {
    message: 'username sólo admite letras, números, punto, guion y guion bajo',
  })
  username: string;

  @IsString() @IsNotEmpty() @MaxLength(120) fullName: string;

  @IsOptional() @IsEmail() @MaxLength(160) email?: string;

  @IsString() @MinLength(PASSWORD_MIN) @MaxLength(200) password: string;

  @IsString() @IsNotEmpty() @MaxLength(64) roleId: string;

  @IsOptional() @IsBoolean() active?: boolean;
}

export class UpdateUserDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(120) fullName?: string;
  @IsOptional() @IsEmail() @MaxLength(160) email?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(64) roleId?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class SetPasswordDto {
  @IsString() @MinLength(PASSWORD_MIN) @MaxLength(200) password: string;
}

export class CreateRoleDto {
  @IsOptional() @IsString() @MaxLength(64) id?: string;
  @IsString() @IsNotEmpty() @MaxLength(80) name: string;

  @IsArray()
  @ArrayUnique()
  @IsEnum(ALL_PERMISSIONS, { each: true })
  permissions: Permission[];
}

export class UpdateRoleDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80) name?: string;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsEnum(ALL_PERMISSIONS, { each: true })
  permissions?: Permission[];
}
