import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * Tiempo máximo para abrir una conexión nueva; sin esto, una base caída deja
 * la llamada colgada. Sales corta a los 800 ms, así que esperar mucho más sólo
 * ocupa recursos; en condiciones normales conectar toma milisegundos.
 */
const CONNECTION_TIMEOUT_MS = 2_000;

/**
 * Única instancia de PrismaClient (y de su pool de conexiones) del proceso.
 *
 * Las conexiones se abren a demanda: el servicio arranca aunque la base no
 * esté disponible todavía, y HealthService informa NOT_SERVING hasta que lo esté.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super({
      adapter: new PrismaPg({ connectionString: config.databaseUrl, connectionTimeoutMillis: CONNECTION_TIMEOUT_MS }),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
