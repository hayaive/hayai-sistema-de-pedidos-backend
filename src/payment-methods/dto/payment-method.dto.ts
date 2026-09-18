import { IsBoolean, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { Currency } from '../../generated/prisma/enums';

const CURRENCIES: Currency[] = ['USD', 'BS'];

export class CreatePaymentMethodDto {
  @IsOptional() @IsString() @MaxLength(64) id?: string;
  @IsString() @IsNotEmpty() @MaxLength(80) name: string;
  @IsEnum(CURRENCIES) currency: Currency;
  @IsOptional() @IsBoolean() requiresReference?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsInt() @Min(0) position?: number;
}

export class UpdatePaymentMethodDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80) name?: string;
  @IsOptional() @IsEnum(CURRENCIES) currency?: Currency;
  @IsOptional() @IsBoolean() requiresReference?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsInt() @Min(0) position?: number;
}
