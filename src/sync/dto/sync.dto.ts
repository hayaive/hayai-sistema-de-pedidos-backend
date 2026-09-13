import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsISO8601,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class SyncQueryDto {
  /**
   * Cursor opaco (§6.4). Internamente es el `rev`; **no se interpreta como
   * fecha** ni se hace aritmética con él en el cliente.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  since: number = 0;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2000)
  limit?: number;
}

export class MutationDto {
  /** UUID del cliente. Es la clave de idempotencia (§4.5). */
  @IsString() @IsNotEmpty() @MaxLength(64) mutationId: string;

  @IsString() @IsNotEmpty() @MaxLength(40) entity: string;

  @IsString() @IsNotEmpty() @MaxLength(40) op: string;

  /** Momento de negocio en el cliente. El servidor lo acota (§4.6). */
  @IsOptional() @IsISO8601() at?: string;

  /** Versión sobre la que se editó (bloqueo optimista). */
  @IsOptional() @IsInt() @Min(0) baseRev?: number;

  @IsOptional() @IsBoolean() offline?: boolean;

  @IsObject() payload: Record<string, unknown>;
}

export class PushSyncDto {
  @IsOptional() @IsString() @MaxLength(64) deviceId?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) cursor?: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MutationDto)
  mutations: MutationDto[];
}
