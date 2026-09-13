import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors';
import { MutationHandler, handlerKey } from '../sync.types';
import { CatalogHandlers } from './catalog.handlers';
import { MoneyHandlers } from './money.handlers';

/**
 * Entidades que **no se editan offline** (ARCHITECTURE.md §5).
 *
 *  · `user`, `role`: una cola offline podría resucitar a un usuario revocado o
 *    devolverle permisos. La separación es de seguridad, no de comodidad.
 *  · `paymentMethod`, `priceType`, `category`: configuración de bajísima
 *    frecuencia; el conflicto no compensa.
 *  · `company`: además, `saleNext`/`orderNext` nunca se aceptan de un cliente.
 */
const ONLINE_ONLY = new Set(['user', 'role', 'paymentMethod', 'priceType', 'category', 'company']);

@Injectable()
export class MutationRegistry {
  private readonly handlers: Map<string, MutationHandler>;

  constructor(money: MoneyHandlers, catalog: CatalogHandlers) {
    this.handlers = new Map(Object.entries({ ...money.handlers(), ...catalog.handlers() }));
  }

  /**
   * Resuelve el handler de `(entity, op)`.
   *
   * Los dos fallos posibles son **permanentes**, y eso es lo importante: el cliente
   * saca la mutación de la cola en lugar de reintentar para siempre.
   */
  resolve(entity: string, op: string): MutationHandler {
    if (ONLINE_ONLY.has(entity)) {
      throw new AppError(
        'online_only',
        `"${entity}" sólo se edita en línea: vuelve a intentarlo con conexión`,
      );
    }

    const handler = this.handlers.get(handlerKey(entity, op));
    if (!handler) {
      throw new AppError('validation_failed', `La operación ${entity}.${op} no existe`);
    }
    return handler;
  }

  /** Las operaciones registradas, para diagnóstico. */
  supported(): string[] {
    return [...this.handlers.keys()].sort();
  }
}
