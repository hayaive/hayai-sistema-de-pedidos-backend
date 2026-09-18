import {
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Parche de la configuración. **No declara `saleNext` ni `orderNext`**: la
 * numeración es propiedad del servidor y aceptarla de un cliente permitiría
 * reemitir un número ya usado (ARCHITECTURE.md §3.2 y §5).
 */
export class UpdateCompanyDto {
  @IsOptional() @IsString() @MaxLength(160) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) logoUrl?: string;
  @IsOptional() @IsString() @MaxLength(60) phone?: string;
  @IsOptional() @IsString() @MaxLength(500) address?: string;
  @IsOptional() @IsString() @MaxLength(40) taxId?: string;
  @IsOptional() @IsString() @MaxLength(500) ticketFooter?: string;

  @IsOptional() @IsString() @MaxLength(8) salePrefix?: string;
  @IsOptional() @IsString() @MaxLength(8) orderPrefix?: string;

  /**
   * Secuencia automática de códigos de producto (Ajustes). `productCodeStart`
   * es un piso, no un contador: el servidor nunca lo avanza al crear un
   * producto (`ProductsService.nextFreeCode`). Las cotas replican los CHECK
   * de `company_settings` en la base (mismo mensaje que un rechazo del
   * servidor: mejor que el cliente los aplique también).
   */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]([A-Z0-9-]{0,6}[A-Z-])?$/)
  productCodePrefix?: string;

  @IsOptional() @IsInt() @Min(1) @Max(6) productCodeDigits?: number;
  @IsOptional() @IsInt() @Min(1) @Max(99999999) productCodeStart?: number;

  /**
   * Banda de precio del producto genérico "Tortas Frías": umbral y objetivo.
   * Desde 2026-09 **no** aplica a la categoría entera, sólo a ese producto
   * (`PricingService.ruleOf`), y por eso `coldCakeCategory` ya no se declara
   * aquí: llega, el ValidationPipe lo descarta y no se persiste.
   */
  @IsOptional() @IsNumber() @Min(0) coldCakeMin?: number;
  @IsOptional() @IsNumber() @Min(0) coldCakeMax?: number;

  @IsOptional() @IsNumber() @Min(0) bsRounding?: number;
  @IsOptional() @IsInt() @Min(1) @Max(720) rateMaxAgeHours?: number;

  /** Zona del día contable. La usa el trigger `set_business_date_*`. */
  @IsOptional() @IsString() @MaxLength(60) timezone?: string;

  @IsOptional() @IsObject() shortcuts?: Record<string, string>;
}
