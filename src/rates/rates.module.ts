import { Global, Module } from '@nestjs/common';
import { RatesController } from './rates.controller';
import { RatesCron } from './rates.cron';
import { RatesService } from './rates.service';

/** Global: ventas, abonos y cierres necesitan la tasa vigente. */
@Global()
@Module({
  controllers: [RatesController],
  providers: [RatesService, RatesCron],
  exports: [RatesService],
})
export class RatesModule {}
