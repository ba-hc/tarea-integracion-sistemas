import { Global, Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { APP_CONFIG, type AppConfig } from './config/app-config.js';
import { GrpcErrorFilter } from './grpc/grpc-error.filter.js';
import { PartsModule } from './parts/parts.module.js';
import { StockModule } from './stock/stock.module.js';

/**
 * La configuración entra por parámetro (y no leyendo process.env adentro) para
 * que las pruebas de integración puedan levantar el mismo módulo contra su
 * propia base.
 */
@Global()
@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [PartsModule, StockModule],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: APP_FILTER, useClass: GrpcErrorFilter },
      ],
      exports: [APP_CONFIG],
    };
  }
}
