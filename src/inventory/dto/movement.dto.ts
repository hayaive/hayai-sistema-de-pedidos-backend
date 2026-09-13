import {
  IsEnum,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { MovementType } from '../../generated/prisma/enums';
import { PaginationDto } from '../../common/dto/pagination.dto';

const TYPES: MovementType[] = ['entrada', 'salida', 'ajuste'];

export class CreateMovementDto {
  /** Id del cliente: la idempotencia del kardex es por PK. */
  @IsOptional() @IsString() @MaxLength(64) id?: string;

  @IsEnum(TYPES) type: MovementType;

  /** En `ajuste` es la existencia final a la que se quiere llevar el producto. */
  @IsNumber() @Min(0) qty: number;

  @IsString() @IsNotEmpty() @MaxLength(120) reason: string;

  @IsOptional() @IsString() @MaxLength(2000) note?: string;

  /** Momento de captura (movimiento creado offline). El servidor lo acota. */
  @IsOptional() @IsISO8601() createdAt?: string;
}

export class MovementsQueryDto extends PaginationDto {
  @IsOptional() @IsString() @MaxLength(64) productId?: string;
  @IsOptional() @IsEnum(TYPES) type?: MovementType;
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
}
