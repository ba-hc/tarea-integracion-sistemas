import { Module } from '@nestjs/common';
import { InventoryGatewayModule } from '../inventory/inventory.module.js';
import { DISPATCH_GATEWAY, HttpDispatchGateway } from './dispatch.client.js';
import { HttpPaymentsGateway, PAYMENTS_GATEWAY } from './payments.client.js';
import { SaleSagaOrchestrator } from './sale-saga.orchestrator.js';
import { SagaRecoveryWorker } from './saga-recovery.worker.js';

/**
 * Saga de venta: orquestador, clientes de Pagos y Despacho y recuperador.
 * `PrismaService` y `SALES_CONFIG` llegan del `PrismaModule` global.
 */
@Module({
  imports: [InventoryGatewayModule],
  providers: [
    { provide: PAYMENTS_GATEWAY, useClass: HttpPaymentsGateway },
    { provide: DISPATCH_GATEWAY, useClass: HttpDispatchGateway },
    SaleSagaOrchestrator,
    SagaRecoveryWorker,
  ],
  exports: [SaleSagaOrchestrator],
})
export class SagaModule {}
