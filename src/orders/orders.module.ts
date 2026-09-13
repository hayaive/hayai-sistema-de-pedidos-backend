import { Global, Module } from '@nestjs/common';
import { DepositsService } from './deposits.service';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

/** Global: `sales` consume los abonos del pedido y `sync` muta pedidos. */
@Global()
@Module({
  controllers: [OrdersController],
  providers: [OrdersService, DepositsService],
  exports: [OrdersService, DepositsService],
})
export class OrdersModule {}
