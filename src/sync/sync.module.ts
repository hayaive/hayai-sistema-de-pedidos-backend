import { Module } from '@nestjs/common';
import { BootstrapService } from './bootstrap.service';
import { DeltaService } from './delta.service';
import { PushService } from './push.service';
import { BootstrapController, SyncController } from './sync.controller';
import { CatalogHandlers } from './mutations/catalog.handlers';
import { MoneyHandlers } from './mutations/money.handlers';
import { MutationRegistry } from './mutations/registry';

/**
 * El módulo de sincronización. Depende de todos los módulos de dominio (que son
 * `@Global()` justamente por esto): los handlers de mutación **reutilizan los
 * mismos servicios** que los endpoints HTTP, para que no existan dos
 * implementaciones de "crear una venta" que puedan divergir.
 */
@Module({
  controllers: [BootstrapController, SyncController],
  providers: [
    BootstrapService,
    DeltaService,
    PushService,
    MutationRegistry,
    MoneyHandlers,
    CatalogHandlers,
  ],
  exports: [BootstrapService, DeltaService, PushService],
})
export class SyncModule {}
