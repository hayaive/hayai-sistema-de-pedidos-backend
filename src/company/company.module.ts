import { Global, Module } from '@nestjs/common';
import { CompanyController } from './company.controller';
import { CompanyService } from './company.service';

/**
 * Global porque la numeración de documentos y la zona del día contable las
 * necesitan ventas, pedidos y cierres.
 */
@Global()
@Module({
  controllers: [CompanyController],
  providers: [CompanyService],
  exports: [CompanyService],
})
export class CompanyModule {}
