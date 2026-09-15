import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PriceInputDto } from './product.dto';

/* ── Categorías ──────────────────────────────────────────────────────────── */

export class CreateCategoryDto {
  @IsOptional() @IsString() @MaxLength(64) id?: string;
  @IsString() @IsNotEmpty() @MaxLength(80) name: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class UpdateCategoryDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80) name?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

/* ── Tipos de precio ─────────────────────────────────────────────────────── */

export class CreatePriceTypeDto {
  @IsOptional() @IsString() @MaxLength(64) id?: string;
  @IsString() @IsNotEmpty() @MaxLength(60) name: string;
  @IsOptional() @IsBoolean() isDefault?: boolean;
  @IsOptional() @IsInt() @Min(0) position?: number;
}

export class UpdatePriceTypeDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(60) name?: string;
  @IsOptional() @IsBoolean() isDefault?: boolean;
  @IsOptional() @IsInt() @Min(0) position?: number;
}

/* ── Grupos de precio ─────────────────────────────────────────────────────────
 *
 * @deprecated 2026-09 · Mecanismo retirado. Estos DTO sólo sostienen las rutas
 * `/price-groups` y las mutaciones `priceGroup*` de sync, vivas mientras queden
 * clientes v5 en circulación. Ver `PriceGroupsService`.
 */

export class PriceBandDto {
  @IsNumber() @Min(0) minUsd: number;
  @IsNumber() @Min(0) maxUsd: number;
}

/**
 * Regla de precio. La forma se preserva tal cual para no romper el wire de un
 * cliente v5 (§3.7):
 *  · regla presente ⇔ `minUsd` y `targetUsd`;
 *  · banda presente ⇔ `band.minUsd` y `band.maxUsd`.
 *
 * Lo que ya NO vale: la banda de un grupo no bloquea ninguna venta. El bloqueo
 * por banda se retiró en 2026-09 (`PricingService`) y la única banda que queda
 * es la de `company_settings`, que aplica al producto genérico "Tortas Frías" y
 * sólo genera alerta en el cliente.
 */
export class PriceRuleDto {
  @IsNumber() @Min(0.0001) minUsd: number;
  @IsNumber() @Min(0) targetUsd: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => PriceBandDto)
  band?: PriceBandDto;
}

export class CreatePriceGroupDto {
  @IsOptional() @IsString() @MaxLength(64) id?: string;
  @IsString() @IsNotEmpty() @MaxLength(120) name: string;
  @IsOptional() @IsString() @MaxLength(64) categoryId?: string;
  @IsOptional() @IsBoolean() active?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PriceInputDto)
  prices?: PriceInputDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => PriceRuleDto)
  rule?: PriceRuleDto;
}

export class UpdatePriceGroupDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(64) categoryId?: string | null;
  @IsOptional() @IsBoolean() active?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PriceInputDto)
  prices?: PriceInputDto[];

  /** `null` quita la regla (y con ella la banda). */
  @IsOptional()
  @ValidateNested()
  @Type(() => PriceRuleDto)
  rule?: PriceRuleDto | null;
}
