import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AdminModule } from './admin/admin.module';
import { ActiveUserGuard } from './auth/active-user.guard';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { PermissionsGuard } from './auth/permissions.guard';
import { AuditModule } from './audit/audit.module';
import { CatalogModule } from './catalog/catalog.module';
import { ClosuresModule } from './closures/closures.module';
import { CompanyModule } from './company/company.module';
import { ConfigModule } from './config/config.module';
import { CustomersModule } from './customers/customers.module';
import { DevicesModule } from './devices/devices.module';
import { HealthModule } from './health/health.module';
import { InventoryModule } from './inventory/inventory.module';
import { OrdersModule } from './orders/orders.module';
import { PaymentMethodsModule } from './payment-methods/payment-methods.module';
import { PrismaModule } from './prisma/prisma.module';
import { RatesModule } from './rates/rates.module';
import { SalesModule } from './sales/sales.module';
import { SyncCoreModule } from './sync/sync-core.module';
import { SyncModule } from './sync/sync.module';
import { UsersModule } from './users/users.module';

/**
 * Los tres guardias son **globales y en este orden**:
 *
 *  1. `ThrottlerGuard`  — límite de peticiones.
 *  2. `JwtAuthGuard`    — autenticación + `X-Device-Id` (salvo `@Public()`).
 *  3. `ActiveUserGuard` — echa a los usuarios desactivados, excepto en
 *                         `POST /sync` (§5).
 *  4. `PermissionsGuard`— aplica `@RequirePermission()`.
 *
 * Que sean globales es deliberado: con guardias por controlador, un endpoint nuevo
 * nace sin autenticación y nadie se da cuenta. Aquí un endpoint nuevo nace cerrado
 * y hay que abrirlo a mano con `@Public()`.
 */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),

    // Infraestructura compartida
    SyncCoreModule,
    AuditModule,
    DevicesModule,
    CompanyModule,

    // Dominio
    AuthModule,
    UsersModule,
    CatalogModule,
    CustomersModule,
    InventoryModule,
    RatesModule,
    PaymentMethodsModule,
    OrdersModule,
    SalesModule,
    ClosuresModule,

    // Sincronización y utilidades
    SyncModule,
    AdminModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: ActiveUserGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
