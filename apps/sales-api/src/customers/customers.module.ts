import { Module } from '@nestjs/common';
import { CustomersController } from './customers.controller.js';
import { CustomersService } from './customers.service.js';

/**
 * Clientes: única fuente de verdad de Sales sobre sus propios clientes.
 * `PrismaService` llega desde el `PrismaModule.register(config)` global que
 * importa AppModule, así que el módulo no declara dependencias propias.
 * El servicio se exporta para que el módulo de órdenes pueda resolver un
 * `customerId` y responder 404 `CUSTOMER_NOT_FOUND`.
 */
@Module({
  controllers: [CustomersController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}
