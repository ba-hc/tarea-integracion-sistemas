import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import type { PaymentsConfig } from './config.js';
import { PrismaClient } from './generated/prisma/client.js';
import { PAYMENTS_CONFIG } from './tokens.js';

@Injectable()
export class PaymentsDatabase extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(PAYMENTS_CONFIG) config: Pick<PaymentsConfig, 'databaseUrl'>) {
    super({ adapter: new PrismaPg({ connectionString: config.databaseUrl, connectionTimeoutMillis: 2_000 }) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
