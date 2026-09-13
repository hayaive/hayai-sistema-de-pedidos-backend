import { Type } from 'class-transformer';
import {
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';

export class ClosureMethodDto {
  @IsString() @IsNotEmpty() @MaxLength(64) methodId: string;

  /** Lo que el cajero contó de verdad. Lo esperado lo calcula el servidor. */
  @IsNumber() @Min(0) received: number;
}

export class CreateClosureDto {
  @IsOptional() @IsString() @MaxLength(64) id?: string;

  /** Día contable a cerrar (`YYYY-MM-DD`). Por defecto, hoy en la zona del negocio. */
  @IsOptional() @IsString() @MaxLength(10) date?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ClosureMethodDto)
  byMethod?: ClosureMethodDto[];

  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

export class ClosuresQueryDto extends PaginationDto {
  @IsOptional() @IsString() @MaxLength(10) from?: string;
  @IsOptional() @IsString() @MaxLength(10) to?: string;
}

export class DraftQueryDto {
  @IsOptional() @IsString() @MaxLength(10) date?: string;
}
