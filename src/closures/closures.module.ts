import { Global, Module } from '@nestjs/common';
import { ClosuresController } from './closures.controller';
import { ClosuresService } from './closures.service';

/** Global: `sync` aplica `closure.create` desde la cola offline. */
@Global()
@Module({
  controllers: [ClosuresController],
  providers: [ClosuresService],
  exports: [ClosuresService],
})
export class ClosuresModule {}
