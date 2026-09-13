import { AuthUser } from '../auth/auth.types';
import { Tx } from '../common/tx';

/** Entidades que `POST /sync` reconoce (ARCHITECTURE.md §6.5). */
export type MutationEntity =
  | 'sale'
  | 'order'
  | 'orderDeposit'
  | 'movement'
  | 'customer'
  | 'product'
  | 'productPrice'
  | 'priceGroupPrice'
  | 'priceGroup'
  | 'rate'
  | 'closure'
  | 'audit'
  // Sólo en línea: se rechazan con `online_only`.
  | 'user'
  | 'role'
  | 'paymentMethod'
  | 'priceType'
  | 'category'
  | 'company';

export type MutationStatusName = 'applied' | 'duplicate' | 'conflict' | 'rejected';

export interface IdMapEntry {
  entity: string;
  localId: string;
  serverId: string;
}

/**
 * Resultado de una mutación. El cliente **tiene que** distinguir `rejected`
 * (permanente: sacar de la cola y avisar) de un error de red (reintentar con el
 * mismo `mutationId`), o entra en bucle infinito (§5, "Retryable vs permanente").
 */
export interface MutationResult {
  mutationId: string;
  status: MutationStatusName;
  entityId?: string;
  serverEntity?: unknown;
  idMap?: IdMapEntry[];
  renumbered?: { from: string; to: string };
  reason?: string;
  retryable: boolean;
}

/** Lo que produce un handler; el orquestador le pone `mutationId` y `retryable`. */
export interface HandlerOutcome {
  status: MutationStatusName;
  entityId?: string;
  serverEntity?: unknown;
  idMap?: IdMapEntry[];
  renumbered?: { from: string; to: string };
  reason?: string;
}

export interface MutationContext {
  tx: Tx;
  user: AuthUser;
  deviceId: string;
  /** Timestamp de negocio del cliente, ya acotado contra el reloj del servidor. */
  clientAt: Date;
  /** El `at` crudo tal como llegó, para la bitácora de idempotencia. */
  rawClientAt: Date | null;
  baseRev: number | null;
  payload: Record<string, unknown>;
  /** true si el cliente lo marcó como creado sin red. */
  offline: boolean;
}

export type MutationHandler = (ctx: MutationContext) => Promise<HandlerOutcome>;

/** Clave del registro de handlers: `${entity}.${op}`. */
export const handlerKey = (entity: string, op: string) => `${entity}.${op}`;
