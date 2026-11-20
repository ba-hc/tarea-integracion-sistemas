import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { SALES_CONFIG, type SalesConfig } from '../config/app-config.js';
import { SaleSagaOrchestrator } from './sale-saga.orchestrator.js';

/** Sagas revisadas por vuelta; acota el trabajo de cada tick. */
const BATCH_SIZE = 20;

/**
 * Recuperador de Sagas (T2-302): retoma compensaciones y cancelaciones
 * pendientes cuando vence su backoff, y aborta las ventas que quedaron con un
 * paso en duda sin reintento del cliente durante `SAGA_ABORT_AFTER_MS`.
 *
 * Es un temporizador dentro de Sales (sin colas ni brokers): el estado vive en
 * `sale_sagas` y el lease evita que dos procesos trabajen la misma Saga.
 */
@Injectable()
export class SagaRecoveryWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('SagaRecovery');
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    @Inject(SaleSagaOrchestrator) private readonly orchestrator: SaleSagaOrchestrator,
    @Inject(SALES_CONFIG) private readonly config: Pick<SalesConfig, 'saga'>,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.saga.recoveryEnabled) return;
    this.timer = setInterval(() => void this.tick(), this.config.saga.recoveryIntervalMs);
    this.timer.unref();
    this.logger.log('saga recovery started', {
      intervalMs: this.config.saga.recoveryIntervalMs,
      abortAfterMs: this.config.saga.abortAfterMs,
    });
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Una vuelta del recuperador. Público para las pruebas; no se solapa consigo mismo. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const orderIds = await this.orchestrator.findRecoverable(BATCH_SIZE);
      for (const orderId of orderIds) await this.orchestrator.recover(orderId);
      return orderIds.length;
    } catch (error) {
      this.logger.error('saga recovery tick failed', { errorType: error instanceof Error ? error.name : 'UnknownError' });
      return 0;
    } finally {
      this.running = false;
    }
  }
}
