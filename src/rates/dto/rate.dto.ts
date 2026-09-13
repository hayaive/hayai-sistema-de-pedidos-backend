import { IsEnum, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { RateSource } from '../../generated/prisma/enums';
import { PaginationDto } from '../../common/dto/pagination.dto';

const SOURCES: RateSource[] = ['BCV_USD', 'BCV_EUR', 'BINANCE'];

export class CreateRateDto {
  /** Id generado por el cliente: hace la publicación idempotente por PK. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  id?: string;

  @IsEnum(SOURCES)
  source: RateSource;

  @IsNumber()
  @Min(0.00000001)
  value: number;
}

export class RatesQueryDto extends PaginationDto {
  @IsOptional()
  @IsEnum(SOURCES)
  source?: RateSource;
}
