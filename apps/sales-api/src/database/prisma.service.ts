import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { SALES_CONFIG, type SalesConfig } from '../config/app-config.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(SALES_CONFIG) config: SalesConfig) {
    super({
      adapter: new PrismaPg({
        connectionString: config.databaseUrl,
        connectionTimeoutMillis: 2_000,
      }),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}