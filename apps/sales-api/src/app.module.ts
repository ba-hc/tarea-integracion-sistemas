import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ApiKeyGuard } from './auth/api-key.guard.js';
import type { SalesConfig } from './config/app-config.js';
import { PrismaModule } from './database/prisma.module.js';
import { CustomersModule } from './customers/customers.module.js';
import { HealthModule } from './health/health.module.js';
import { InventoryGatewayModule } from './inventory/inventory.module.js';
import { OrdersModule } from './orders/orders.module.js';

@Module({})
export class AppModule {
  static register(config: SalesConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [PrismaModule.register(config), HealthModule, CustomersModule, InventoryGatewayModule, OrdersModule],
      providers: [{ provide: APP_GUARD, useClass: ApiKeyGuard }],
    };
  }
}