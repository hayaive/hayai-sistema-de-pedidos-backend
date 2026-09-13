import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsISO8601,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { OrderStatus } from '../../generated/prisma/enums';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { LineItemDto } from '../../common/dto/line-item.dto';

const STATUSES: OrderStatus[] = ['pendiente', 'preparacion', 'listo', 'procesado', 'cancelado'];

export class CreateDepositDto {
  @IsOptional() @IsString() @MaxLength(64) id?: string;

  @IsString() @IsNotEmpty() @MaxLength(64) methodId: string;

  /** Monto en la moneda del método de pago. */
  @IsNumber() @Min(0.0001) amount: number;

  @IsOptional() @IsString() @MaxLength(80) reference?: string;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;

  /** Fecha real de recepción del dinero; el servidor la acota. */
  @IsOptional() @IsISO8601() at?: string;

  /**
   * Tasa congelada al recibir el abono. Si falta se usa la BCV vigente. En un
   * abono offline es obligatoria de hecho: es la tasa a la que entró el dinero.
   */
  @IsOptional() @IsNumber() @Min(0.00000001) rateUsed?: number;
}

export class CreateOrderDto {
  @IsOptional() @IsString() @MaxLength(64) id?: string;

  /** Número provisional de un pedido creado offline. El definitivo lo pone el servidor. */
  @IsOptional() @IsString() @MaxLength(24) number?: string;

  @IsOptional() @IsString() @MaxLength(64) customerId?: string | null;
  @IsOptional() @IsString() @MaxLength(160) customerName?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LineItemDto)
  items: LineItemDto[];

  @IsOptional() @IsString() @MaxLength(2000) note?: string;

  /** Momento de creación (pedido offline). El servidor lo acota. */
  @IsOptional() @IsISO8601() createdAt?: string;

  /** Abono adelantado en el mismo acto. Si es inválido, no se crea el pedido. */
  @IsOptional()
  @ValidateNested()
  @Type(() => CreateDepositDto)
  deposit?: CreateDepositDto;
}

/**
 * Parche del pedido. `totalUsd` no se declara: lo **recalcula el servidor** desde
 * las líneas y jamás se acepta del cliente (ARCHITECTURE.md §5).
 *
 * `items` se reemplaza **en bloque**: fusionar arrays de líneas pierde o duplica
 * ítems, y aquí eso es dinero.
 */
export class UpdateOrderDto {
  @IsOptional() @IsString() @MaxLength(64) customerId?: string | null;
  @IsOptional() @IsString() @MaxLength(160) customerName?: string;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LineItemDto)
  items?: LineItemDto[];

  /** Sólo hacia adelante: la máquina de estados es monótona. */
  @IsOptional() @IsEnum(STATUSES) status?: OrderStatus;

  /** Obligatorio al cancelar. */
  @IsOptional() @IsString() @MaxLength(300) cancelReason?: string;

  /** `baseRev` expresado en el cuerpo, para `POST /sync`. En HTTP va en `If-Match`. */
  @IsOptional() @IsInt() @Min(0) baseRev?: number;
}

export class SetOrderStatusDto {
  @IsEnum(STATUSES) status: OrderStatus;

  @IsOptional() @IsString() @MaxLength(300) reason?: string;

  @IsOptional() @IsInt() @Min(0) baseRev?: number;
}

export class VoidDepositDto {
  @IsString() @IsNotEmpty() @MaxLength(300) reason: string;
}

export class OrdersQueryDto extends PaginationDto {
  @IsOptional() @IsEnum(STATUSES) status?: OrderStatus;
  @IsOptional() @IsString() @MaxLength(64) customerId?: string;
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
}
