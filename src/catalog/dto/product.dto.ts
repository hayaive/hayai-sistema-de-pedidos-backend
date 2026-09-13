import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';

export class PriceInputDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  priceTypeId: string;

  @IsNumber()
  @Min(0)
  amount: number;
}

export class ComboItemInputDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  description: string;

  @IsNumber()
  @Min(0.001)
  qty: number;

  /** Producto del catálogo, si la línea del combo apunta a uno. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  productId?: string;
}

export class CreateProductDto {
  /** Id generado por el cliente (`crypto.randomUUID()`). */
  @IsOptional() @IsString() @MaxLength(64) id?: string;

  @IsString() @IsNotEmpty() @MaxLength(32) code: string;
  @IsString() @IsNotEmpty() @MaxLength(160) name: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsString() @IsNotEmpty() @MaxLength(64) categoryId: string;
  @IsOptional() @IsString() @MaxLength(2000) imageUrl?: string;

  /**
   * `stock` NO se declara: no es escribible por ningún cliente. La existencia
   * sólo se mueve registrando un movimiento de inventario (§3.6).
   */
  @IsOptional() @IsNumber() @Min(0) minStock?: number;
  @IsOptional() @IsBoolean() active?: boolean;

  @IsOptional() @IsBoolean() bsOnly?: boolean;
  @IsOptional() @IsNumber() @Min(0) bsPrice?: number;

  @IsOptional() @IsString() @MaxLength(64) priceGroupId?: string;

  @IsOptional() @IsBoolean() isCombo?: boolean;
  @IsOptional() @IsBoolean() allowCustomization?: boolean;
  @IsOptional() @IsNumber() @Min(0) customizationPrice?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PriceInputDto)
  prices?: PriceInputDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ComboItemInputDto)
  comboItems?: ComboItemInputDto[];
}

/**
 * Parche. Se aplica con **LWW por campo**: sólo compiten los campos que los dos
 * dispositivos tocaron (§5, principio 4). Por eso las actualizaciones viajan
 * como parche y no como snapshot.
 */
export class UpdateProductDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(32) code?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(160) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsString() @MaxLength(64) categoryId?: string;
  @IsOptional() @IsString() @MaxLength(2000) imageUrl?: string;
  @IsOptional() @IsNumber() @Min(0) minStock?: number;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsBoolean() bsOnly?: boolean;
  @IsOptional() @IsNumber() @Min(0) bsPrice?: number;
  /** `null` desvincula el producto de su grupo de precio. */
  @IsOptional() @IsString() @MaxLength(64) priceGroupId?: string | null;
  @IsOptional() @IsBoolean() isCombo?: boolean;
  @IsOptional() @IsBoolean() allowCustomization?: boolean;
  @IsOptional() @IsNumber() @Min(0) customizationPrice?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PriceInputDto)
  prices?: PriceInputDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ComboItemInputDto)
  comboItems?: ComboItemInputDto[];
}

export class ProductsQueryDto extends PaginationDto {
  @IsOptional() @IsString() @MaxLength(120) search?: string;
  @IsOptional() @IsString() @MaxLength(64) categoryId?: string;

  /** `?active=true|false`; ausente = todos. */
  @IsOptional()
  @Type(() => String)
  @IsIn(['true', 'false'])
  active?: string;
}

/** `productPrice.set` / `priceGroupPrice.set`: la celda es la unidad de conflicto. */
export class SetPriceDto {
  @IsString() @IsNotEmpty() @MaxLength(64) priceTypeId: string;
  @IsNumber() @Min(0) amount: number;
}
