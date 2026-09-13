import { IsBoolean, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';

/**
 * El formato de la cédula se valida **en el DTO, no con un CHECK**: un CHECK de
 * formato rechazaría valores heredados y reventaría la importación inicial
 * (ARCHITECTURE.md §2). Lo que sí es CHECK es que esté en mayúsculas.
 */
const CEDULA = /^[VEJGPvejgp]-?\d{5,12}$/;

export class CreateCustomerDto {
  @IsOptional() @IsString() @MaxLength(64) id?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(24)
  @Matches(CEDULA, { message: 'cedula debe tener la forma V-12345678' })
  cedula: string;

  @IsString() @IsNotEmpty() @MaxLength(160) name: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(500) address?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class UpdateCustomerDto {
  @IsOptional()
  @IsString()
  @MaxLength(24)
  @Matches(CEDULA, { message: 'cedula debe tener la forma V-12345678' })
  cedula?: string;

  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(160) name?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(500) address?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class CustomersQueryDto extends PaginationDto {
  @IsOptional() @IsString() @MaxLength(120) search?: string;
}
