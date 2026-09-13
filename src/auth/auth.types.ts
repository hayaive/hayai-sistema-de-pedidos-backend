import { Permission } from '../generated/prisma/enums';

/** Lo que queda colgado de `request.user` tras pasar el guardia de JWT. */
export interface AuthUser {
  id: string;
  username: string;
  fullName: string;
  roleId: string;
  permissions: Permission[];
  /**
   * Un usuario desactivado **no puede operar**, pero sí subir la cola de
   * mutaciones que creó antes de la revocación: son hechos de negocio que ya
   * ocurrieron y descartarlos sería perder dinero del registro
   * (ARCHITECTURE.md §5, "Usuario desactivado con cola pendiente").
   *
   * Por eso el estado llega hasta aquí en lugar de cortarse en la estrategia: el
   * único sitio que acepta a un usuario inactivo es `POST /sync`, marcado con
   * `@AllowDeactivated()`, y allí cada mutación se compara contra
   * `deactivatedAt`.
   */
  active: boolean;
  deactivatedAt: Date | null;
}

/** Payload del access token. Corto a propósito: los permisos se leen de la BD. */
export interface AccessTokenPayload {
  /** userId */
  sub: string;
  username: string;
  roleId: string;
}

/**
 * El request enriquecido por los guardias. `deviceId` viene de `X-Device-Id` y
 * ya está garantizado en la tabla `devices` (hay FKs que lo referencian).
 */
export interface RequestWithAuth {
  user?: AuthUser;
  deviceId?: string;
  headers: Record<string, string | string[] | undefined>;
  method: string;
  url: string;
}
