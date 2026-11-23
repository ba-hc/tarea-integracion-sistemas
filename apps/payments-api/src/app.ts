import 'reflect-metadata';
import { Module, type DynamicModule, type INestApplication, type LoggerService, type LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { PaymentsConfig } from './config.js';
import { PaymentsDatabase } from './database.js';
import { GatewayClient } from './gateway/gateway.client.js';
import { PaymentsExceptionFilter, traceRequest } from './http.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsReconciler } from './payments.reconciler.js';
import { PaymentsService } from './payments.service.js';
import { GatewayGuard } from './resilience/gateway-guard.js';
import { PAYMENTS_CONFIG } from './tokens.js';

@Module({})
export class PaymentsModule {
  static register(config: PaymentsConfig): DynamicModule {
    return {
      module: PaymentsModule,
      controllers: [PaymentsController],
      providers: [
        { provide: PAYMENTS_CONFIG, useValue: config },
        PaymentsDatabase,
        GatewayClient,
        GatewayGuard,
        PaymentsService,
        PaymentsReconciler,
      ],
    };
  }
}

export async function createApp(
  config: PaymentsConfig,
  logger?: LoggerService | LogLevel[] | false,
): Promise<INestApplication> {
  const app = await NestFactory.create(PaymentsModule.register(config), logger === undefined ? {} : { logger });
  app.enableShutdownHooks();
  app.use(traceRequest);
  app.useGlobalFilters(new PaymentsExceptionFilter());
  return app;
}
