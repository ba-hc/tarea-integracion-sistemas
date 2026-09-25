import { Global, Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import type { HealthImplementation } from 'grpc-health-check';
import { APP_CONFIG, type AppConfig } from './config/app-config.js';
import { GrpcErrorFilter } from './grpc/grpc-error.filter.js';
import { HEALTH_IMPLEMENTATION } from './health/health.service.js';
import { HealthModule } from './health/health.module.js';
import { GrpcLoggingInterceptor } from './logging/grpc-logging.interceptor.js';
import { PartsModule } from './parts/parts.module.js';
import { StockModule } from './stock/stock.module.js';

/**
 * La configuración y el health check entran por parámetro (y no se crean
 * adentro) porque el servidor gRPC los necesita antes de que exista el
 * contenedor de Nest, y para que las pruebas levanten el mismo módulo contra
 * su propia base.
 */
@Global()
@Module({})
export class AppModule {
  static register(config: AppConfig, health: HealthImplementation): DynamicModule {
    return {
      module: AppModule,
      imports: [PartsModule, StockModule, HealthModule],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: HEALTH_IMPLEMENTATION, useValue: health },
        { provide: APP_FILTER, useClass: GrpcErrorFilter },
        { provide: APP_INTERCEPTOR, useClass: GrpcLoggingInterceptor },
      ],
      exports: [APP_CONFIG, HEALTH_IMPLEMENTATION],
    };
  }
}
