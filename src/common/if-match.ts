import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { invalid } from './errors';

/**
 * `If-Match: <rev>` → number | null (ARCHITECTURE.md §6.7). Es el mismo
 * `baseRev` de `POST /sync`, expresado en HTTP: una sola columna, un solo
 * significado.
 *
 * Se aceptan tanto `If-Match: 42` como la forma con comillas de HTTP
 * (`If-Match: "42"`), porque algunos clientes citan el ETag automáticamente.
 */
export const IfMatch = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): number | null => {
    const req = ctx.switchToHttp().getRequest<{ headers: Record<string, unknown> }>();
    const raw = req.headers['if-match'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value === undefined || value === null || String(value).trim() === '') return null;

    const text = String(value).trim().replace(/^W\//, '').replace(/^"|"$/g, '');
    const rev = Number(text);
    if (!Number.isInteger(rev) || rev < 0) {
      throw invalid('If-Match tiene que ser el `rev` numérico de la entidad');
    }
    return rev;
  },
);
