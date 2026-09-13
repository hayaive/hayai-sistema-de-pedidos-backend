import {
  IsBoolean,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Línea de venta o de pedido.
 *
 * `code` y `name` los manda el cliente y se guardan **tal cual**: son la foto
 * histórica del momento y un comprobante viejo tiene que seguir leyéndose igual
 * aunque el producto cambie de nombre (ARCHITECTURE.md §3.3). Si no vienen, se
 * toman del catálogo.
 *
 * `subtotalUsd`, en cambio, lo **recalcula el servidor** a partir de `qty`,
 * `unitPriceUsd` y `customizationPrice`: es dinero derivado y aceptarlo del
 * cliente permitiría una venta cuyo total no cuadra con sus propias líneas.
 */
export class LineItemDto {
  @IsString() @IsNotEmpty() @MaxLength(64) productId: string;

  @IsOptional() @IsString() @MaxLength(32) code?: string;
  @IsOptional() @IsString() @MaxLength(160) name?: string;

  @IsNumber() @Min(0.001) qty: number;

  @IsString() @IsNotEmpty() @MaxLength(64) priceTypeId: string;

  @IsNumber() @Min(0) unitPriceUsd: number;

  /** Sólo en líneas `bsOnly`: el precio fijado en Bs, que no se convierte. */
  @IsOptional() @IsNumber() @Min(0) unitPriceBs?: number;

  @IsOptional() @IsBoolean() bsOnly?: boolean;

  @IsOptional() @IsString() @MaxLength(300) customization?: string;
  @IsOptional() @IsNumber() @Min(0) customizationPrice?: number;
}

/**
 * Pago de una venta.
 *
 * `currency` y `usdEquivalent` los **deriva el servidor**: la moneda sale del
 * método de pago y el equivalente en USD del monto y la tasa congelada. Así es
 * imposible asentar un cobro en Bs cuyo equivalente en USD no corresponda a la
 * tasa que dice haber usado.
 */
export class PaymentDto {
  @IsString() @IsNotEmpty() @MaxLength(64) methodId: string;

  /** Monto en la moneda del método de pago. */
  @IsNumber() @Min(0.0001) amount: number;

  @IsOptional() @IsString() @MaxLength(80) reference?: string;

  /**
   * Momento real en que entró el dinero. Si falta, el de la venta. Un abono
   * cobrado días antes lo conserva para que el cierre lo cuente en SU día.
   */
  @IsOptional() @IsISO8601() at?: string;

  /**
   * Tasa con la que se calculó el equivalente en USD. Si falta, la del snapshot
   * de la venta. Obligatoria de hecho para los pagos en Bs (CHECK
   * `sale_payments_bs_needs_rate_ck`).
   */
  @IsOptional() @IsNumber() @Min(0.00000001) rateUsed?: number;
}
