import { Global, Module } from '@nestjs/common';
import { CursorService } from './cursor.service';
import { TombstonesService } from './tombstones.service';

/**
 * El cursor lo necesitan `auth` (lo devuelve el login), `bootstrap` y `sync`.
 * Vive en su propio módulo global para que `auth` no tenga que importar el
 * módulo de sincronización completo, que a su vez depende de ventas y pedidos.
 */
@Global()
@Module({
  providers: [CursorService, TombstonesService],
  exports: [CursorService, TombstonesService],
})
export class SyncCoreModule {}
