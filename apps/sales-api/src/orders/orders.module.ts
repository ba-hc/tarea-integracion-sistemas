import { Module } from '@nestjs/common';
import { InventoryGatewayModule } from '../inventory/inventory.module.js';
import { PrismaModule } from '../database/prisma.module.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';

@Module({
  imports: [PrismaModule, InventoryGatewayModule],
  controllers: [OrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}