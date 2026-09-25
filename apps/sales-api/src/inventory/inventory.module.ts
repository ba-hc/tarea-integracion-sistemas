import { Module } from '@nestjs/common';
import { SALES_CONFIG, type SalesConfig } from '../config/app-config.js';
import { InventoryGrpcGateway } from './inventory-grpc.gateway.js';
import { INVENTORY_GATEWAY } from './inventory.gateway.js';
import { createInventoryServiceClient, INVENTORY_SERVICE_CLIENT } from './inventory-service-client.js';

/**
 * Único punto donde se elige la implementación de InventoryGateway: la
 * orquestación de órdenes inyecta INVENTORY_GATEWAY y desconoce el transporte.
 *
 * `SALES_CONFIG` lo provee el `PrismaModule.register(config)` global que importa
 * AppModule, así que este módulo no declara dependencias propias.
 */
@Module({
  providers: [
    {
      provide: INVENTORY_SERVICE_CLIENT,
      useFactory: (config: SalesConfig) => createInventoryServiceClient(config),
      inject: [SALES_CONFIG],
    },
    { provide: INVENTORY_GATEWAY, useClass: InventoryGrpcGateway },
  ],
  exports: [INVENTORY_GATEWAY],
})
export class InventoryGatewayModule {}
