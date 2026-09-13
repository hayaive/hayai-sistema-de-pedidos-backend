import { plainToInstance } from 'class-transformer';
import { validateSync, ValidationError } from 'class-validator';
import { AppError } from './errors';

/**
 * Valida el `payload` de una mutación de `POST /sync` contra el mismo DTO que usa
 * el endpoint HTTP equivalente.
 *
 * Que los dos caminos compartan DTO es deliberado: si la cola offline validara
 * menos que el endpoint en línea, el modo offline sería una puerta trasera para
 * meter datos que la API rechaza. Y el §4.1 dice que **el camino de escritura es
 * uno solo**, con o sin red.
 */
export function parsePayload<T extends object>(
  cls: new () => T,
  payload: unknown,
  context = 'payload',
): T {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AppError('validation_failed', `${context} tiene que ser un objeto`);
  }

  const instance = plainToInstance(cls, payload, { enableImplicitConversion: false });
  const errors = validateSync(instance as object, {
    whitelist: true,
    forbidNonWhitelisted: false,
    forbidUnknownValues: false,
  });

  if (errors.length) {
    throw new AppError('validation_failed', `${context} no es válido`, flatten(errors));
  }
  return instance;
}

function flatten(errors: ValidationError[], prefix = ''): string[] {
  const out: string[] = [];
  for (const error of errors) {
    const path = prefix ? `${prefix}.${error.property}` : error.property;
    if (error.constraints) out.push(...Object.values(error.constraints).map((m) => `${path}: ${m}`));
    if (error.children?.length) out.push(...flatten(error.children, path));
  }
  return out;
}
