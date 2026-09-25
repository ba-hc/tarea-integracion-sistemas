import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { HealthImplementation, type ServingStatus } from 'grpc-health-check';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { INVENTORY_PACKAGE, INVENTORY_SERVICE } from '../grpc/inventory.proto-types.js';
import { PrismaService } from '../prisma/prisma.service.js';

export const HEALTH_IMPLEMENTATION = Symbol('HEALTH_IMPLEMENTATION');

/** Nombres que responde grpc.health.v1.Health/Check: "" (el servidor completo) y el servicio. */
export const HEALTH_SERVICE_NAMES = ['', `${INVENTORY_PACKAGE}.${INVENTORY_SERVICE}`] as const;

const PROBE_TIMEOUT_MS = 2_000;

/**
 * Se crea fuera de Nest porque el servidor gRPC lo registra antes de que el
 * contenedor de Nest exista. Arranca en NOT_SERVING: nadie debería enviar
 * tráfico hasta que se confirme la base de datos.
 */
export function createHealthImplementation(): HealthImplementation {
  return new HealthImplementation(Object.fromEntries(HEALTH_SERVICE_NAMES.map((name) => [name, 'NOT_SERVING'])));
}

/**
 * Mantiene el health check alineado con la disponibilidad real: SERVING sólo
 * si la base de Inventory responde. Sin base, el servicio no puede atender
 * ninguna RPC, así que no debe declararse sano aunque el proceso esté vivo.
 */
@Injectable()
export class HealthService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(HealthService.name);
  private timer: NodeJS.Timeout | undefined;
  private status: ServingStatus = 'NOT_SERVING';
  private shuttingDown = false;

  constructor(
    @Inject(HEALTH_IMPLEMENTATION) private readonly health: HealthImplementation,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.probe();
    this.timer = setInterval(() => void this.probe(), this.config.healthCheckIntervalMs);
    // El intervalo no debe mantener vivo el proceso por sí solo.
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  getStatus(): ServingStatus {
    return this.status;
  }

  /** Primer paso del apagado: avisa que ya no se debe enviar tráfico nuevo. */
  markShuttingDown(): void {
    this.shuttingDown = true;
    clearInterval(this.timer);
    this.setStatus('NOT_SERVING', 'shutting down');
  }

  /** Comprueba la base con `SELECT 1` y actualiza el estado. Nunca lanza. */
  async probe(): Promise<ServingStatus> {
    if (this.shuttingDown) {
      return this.status;
    }
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.prisma.$queryRaw`SELECT 1`,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`database probe timed out after ${PROBE_TIMEOUT_MS} ms`)), PROBE_TIMEOUT_MS);
        }),
      ]);
      if (!this.shuttingDown) {
        this.setStatus('SERVING', 'database reachable');
      }
    } catch (error) {
      if (!this.shuttingDown) {
        this.setStatus('NOT_SERVING', error instanceof Error ? error.message : 'database probe failed');
      }
    } finally {
      clearTimeout(timeout);
    }
    return this.status;
  }

  private setStatus(status: ServingStatus, reason: string): void {
    for (const name of HEALTH_SERVICE_NAMES) {
      this.health.setStatus(name, status);
    }
    if (status !== this.status) {
      // Sólo se registran los cambios de estado, no cada sondeo.
      const log = status === 'SERVING' ? 'log' : 'warn';
      this.logger[log]('health status changed', { from: this.status, to: status, reason });
      this.status = status;
    }
  }
}
