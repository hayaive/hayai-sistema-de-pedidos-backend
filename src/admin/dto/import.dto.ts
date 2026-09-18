import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsISO8601,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { RateSource } from '../../generated/prisma/enums';

/**
 * El `AppState` del frontend, tal como sale de su `localStorage`.
 *
 * Sólo se declaran las partes que la importación acepta: catálogo, clientes,
 * tasas y configuración de precios. Ventas, pedidos, movimientos y cierres no
 * entran por aquí (ver `AdminService.importState`).
 */

class ImportPriceDto {
  @IsString() @IsNotEmpty() @MaxLength(64) priceTypeId: string;
  @IsNumber() @Min(0) amount: number;
}

class ImportBandDto {
  @IsNumber() @Min(0) minUsd: number;
  @IsNumber() @Min(0) maxUsd: number;
}

class ImportRuleDto {
  @IsNumber() @Min(0) minUsd: number;
  @IsNumber() @Min(0) targetUsd: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => ImportBandDto)
  band?: ImportBandDto;
}

class ImportComboItemDto {
  @IsString() @IsNotEmpty() @MaxLength(160) description: string;
  @IsNumber() @Min(0.001) qty: number;
  @IsOptional() @IsString() @MaxLength(64) productId?: string;
}

export class ImportCategoryDto {
  @IsString() @IsNotEmpty() @MaxLength(64) id: string;
  @IsString() @IsNotEmpty() @MaxLength(80) name: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class ImportPriceTypeDto {
  @IsString() @IsNotEmpty() @MaxLength(64) id: string;
  @IsString() @IsNotEmpty() @MaxLength(60) name: string;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}

export class ImportPriceGroupDto {
  @IsString() @IsNotEmpty() @MaxLength(64) id: string;
  @IsString() @IsNotEmpty() @MaxLength(120) name: string;
  @IsOptional() @IsString() @MaxLength(64) categoryId?: string;
  @IsOptional() @IsBoolean() active?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImportPriceDto)
  prices?: ImportPriceDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => ImportRuleDto)
  rule?: ImportRuleDto;
}

export class ImportProductDto {
  @IsString() @IsNotEmpty() @MaxLength(64) id: string;
  @IsString() @IsNotEmpty() @MaxLength(32) code: string;
  @IsString() @IsNotEmpty() @MaxLength(160) name: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsString() @IsNotEmpty() @MaxLength(64) categoryId: string;
  @IsOptional() @IsString() @MaxLength(2000) imageUrl?: string;

  /** Entra como movimiento de ajuste, no como valor de columna. */
  @IsOptional() @IsNumber() @Min(0) stock?: number;
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
  @Type(() => ImportPriceDto)
  prices?: ImportPriceDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImportComboItemDto)
  comboItems?: ImportComboItemDto[];
}

export class ImportCustomerDto {
  @IsString() @IsNotEmpty() @MaxLength(64) id: string;
  @IsString() @IsNotEmpty() @MaxLength(24) cedula: string;
  @IsString() @IsNotEmpty() @MaxLength(160) name: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(500) address?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class ImportRateDto {
  @IsString() @IsNotEmpty() @MaxLength(64) id: string;
  @IsEnum(['BCV_USD', 'BCV_EUR', 'BINANCE'] as RateSource[]) source: RateSource;
  @IsNumber() @Min(0.00000001) value: number;
  @IsOptional() @IsBoolean() automatic?: boolean;
  @IsOptional() @IsString() @MaxLength(64) userId?: string | null;
  @IsOptional() @IsISO8601() createdAt?: string;
}

export class ImportPaymentMethodDto {
  @IsString() @IsNotEmpty() @MaxLength(64) id: string;
  @IsString() @IsNotEmpty() @MaxLength(80) name: string;
  @IsIn(['USD', 'BS']) currency: 'USD' | 'BS';
  @IsOptional() @IsBoolean() requiresReference?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class ImportStateDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImportCategoryDto)
  categories?: ImportCategoryDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImportPriceTypeDto)
  priceTypes?: ImportPriceTypeDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImportPriceGroupDto)
  priceGroups?: ImportPriceGroupDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImportProductDto)
  products?: ImportProductDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImportCustomerDto)
  customers?: ImportCustomerDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImportRateDto)
  rates?: ImportRateDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImportPaymentMethodDto)
  paymentMethods?: ImportPaymentMethodDto[];
}
