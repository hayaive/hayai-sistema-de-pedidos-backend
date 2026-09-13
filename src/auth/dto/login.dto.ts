import { Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class LoginDeviceDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  id: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  userAgent?: string;
}

export class LoginDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  username: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  password: string;

  @ValidateNested()
  @Type(() => LoginDeviceDto)
  device: LoginDeviceDto;
}

export class RefreshDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(400)
  refreshToken: string;
}
