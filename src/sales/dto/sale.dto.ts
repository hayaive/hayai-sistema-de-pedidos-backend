import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { SaleStatus } from '../../generated/prisma/enums';
import { LineItemDto, PaymentDto } from '../../common/dto/line-item.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';

/** Tasa congelada de una venta creada offline (`Sale.rateSnapshot` del frontend). */
export class RateSnapshotDto {
  @IsNumber() @Min(0) usd: number;
  @IsOptional() @IsNumber() @Min(0) eur?: number;
  @IsOptional() @IsNumber() @Min(0) binance?: number;
  @IsOptional() @IsISO8601() at?: string;
}

export class CreateSaleDto {
  @IsOptional() @IsString() @MaxLength(64) id?: string;

  /** Número provisional de una venta offline. El definitivo lo pone el servidor. */
  @IsOptional() @IsString() @MaxLength(24) number?: string;

  @IsOptional() @IsString() @MaxLength(64) customerId?: string | null;
  @IsOptional() @IsString() @MaxLength(160) customerName?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LineItemDto)
  items: LineItemDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PaymentDto)
  payments?: PaymentDto[];

  @IsOptional() @IsString() @MaxLength(2000) note?: string;

  /** Pedido que se factura con esta venta. Consume sus abonos vigentes. */
  @IsOptional() @IsString() @MaxLength(64) orderId?: string;

  @IsOptional() @IsISO8601() createdAt?: string;

  /**
   * Tasa con la que se cobró. En una venta offline es la que vio el cajero; si
   * falta, el servidor congela la vigente.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => RateSnapshotDto)
  rateSnapshot?: RateSnapshotDto;

  /**
   * Vuelto entregado. Si falta, el servidor lo deriva de `pagado − total`. Se
   * acepta porque el cajero sabe cuánto devolvió de verdad.
   */
  @IsOptional() @IsNumber() @Min(0) changeUsd?: number;

  /** Marca la venta como creada sin red: su ticket puede haberse renumerado. */
  @IsOptional() @IsBoolean() createdOffline?: boolean;
}

export class VoidSaleDto {
  @IsString() @IsNotEmpty() @MaxLength(300) reason: string;
}

export class SalesQueryDto extends PaginationDto {
  @IsOptional() @IsEnum(['completada', 'anulada'] as SaleStatus[]) status?: SaleStatus;
  @IsOptional() @IsString() @MaxLength(64) customerId?: string;

  /** Filtran por **día contable** (`business_date`), no por `createdAt` en UTC. */
  @IsOptional() @IsString() @MaxLength(10) from?: string;
  @IsOptional() @IsString() @MaxLength(10) to?: string;
}
