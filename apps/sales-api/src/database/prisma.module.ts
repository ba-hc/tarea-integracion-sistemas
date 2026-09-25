import { Global, Module, type DynamicModule } from '@nestjs/common';
import { SALES_CONFIG, type SalesConfig } from '../config/app-config.js';
import { PrismaService } from './prisma.service.js';

@Global()
@Module({})
export class PrismaModule {
  static register(config: SalesConfig): DynamicModule {
    return {
      global: true,
      module: PrismaModule,
      providers: [
        { provide: SALES_CONFIG, useValue: config },
        PrismaService,
      ],
      exports: [SALES_CONFIG, PrismaService],
    };
  }
}