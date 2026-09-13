import { Global, Module } from '@nestjs/common';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';

/** Global: `sync` aplica `sale.create` y `sale.void` desde la cola offline. */
@Global()
@Module({
  controllers: [SalesController],
  providers: [SalesService],
  exports: [SalesService],
})
export class SalesModule {}
