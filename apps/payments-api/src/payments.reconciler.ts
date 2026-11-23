import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PaymentsConfig } from './config.js';
import { PaymentsDatabase } from './database.js';
import type { Payment } from './generated/prisma/client.js';
import { GatewayClient, breakerOutcome, type LookupResult } from './gateway/gateway.client.js';
import { GatewayGuard } from './resilience/gateway-guard.js';
import { PAYMENTS_CONFIG } from './tokens.js';

const BATCH_SIZE = 20;

export interface ReconcilerSnapshot {
  readonly enabled: boolean;
  readonly runs: number;
  readonly resolved: number;
}

/**
 * Resuelve cobros y reembolsos cuyo resultado quedó incierto consultando la
 * pasarela por la clave estable `charge-{orderId}`. La consulta es de sólo
 * lectura: nunca crea ni repite un cobro. Si la pasarela no conoce el cobro,
 * el registro sigue PENDING; lo resuelve un reintento del mismo cobro o un
 * reembolso (que anula la clave).
 */
@Injectable()
export class PaymentsReconciler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('PaymentsReconciler');
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private runs = 0;
  private resolved = 0;

  constructor(
    @Inject(PAYMENTS_CONFIG) private readonly config: PaymentsConfig,
    @Inject(PaymentsDatabase) private readonly db: PaymentsDatabase,
    @Inject(GatewayClient) private readonly gateway: GatewayClient,
    @Inject(GatewayGuard) private readonly guard: GatewayGuard,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.reconcileIntervalMs === 0) return;
    this.timer = setInterval(() => void this.runOnce(), this.config.reconcileIntervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  snapshot(): ReconcilerSnapshot {
    return { enabled: this.config.reconcileIntervalMs > 0, runs: this.runs, resolved: this.resolved };
  }

  /** Revisa un lote de registros inciertos. Devuelve cuántos resolvió. */
  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    this.runs += 1;
    let resolvedNow = 0;
    try {
      // Sólo registros sin una llamada original que pueda seguir en curso.
      const settledBefore = new Date(Date.now() - 2 * this.config.gateway.timeoutMs);
      const candidates = await this.db.payment.findMany({
        where: {
          updatedAt: { lt: settledBefore },
          OR: [{ status: 'PENDING', gatewayAttempts: { gt: 0 } }, { status: 'REFUND_PENDING' }],
        },
        orderBy: { updatedAt: 'asc' },
        take: BATCH_SIZE,
      });
      for (const payment of candidates) {
        const admission = this.guard.admit();
        if (!admission.admitted) break;
        let result: LookupResult | undefined;
        try {
          result = await this.gateway.lookup(payment.orderId, randomUUID());
        } finally {
          admission.release(result ? breakerOutcome(result) : 'ignored');
        }
        if (await this.apply(payment, result)) resolvedNow += 1;
      }
    } catch (error) {
      this.logger.error(`reconciliation failed type=${error instanceof Error ? error.name : 'UnknownError'}`);
    } finally {
      this.running = false;
    }
    this.resolved += resolvedNow;
    return resolvedNow;
  }

  private async apply(payment: Payment, result: LookupResult): Promise<boolean> {
    const { orderId, status } = payment;
    let data: Parameters<PaymentsDatabase['payment']['updateMany']>[0]['data'] | undefined;
    if (result.kind === 'found') {
      if (status === 'PENDING' && result.status === 'APPROVED') {
        data = { status: 'CHARGED', gatewayChargeId: result.chargeId, lastErrorCode: null };
      } else if (result.status === 'DECLINED') {
        data = { status: 'DECLINED', lastErrorCode: null };
      } else if (status === 'REFUND_PENDING' && (result.status === 'REFUNDED' || result.status === 'VOIDED')) {
        data = { status: 'REFUNDED', refundOutcome: result.status === 'VOIDED' ? 'VOIDED' : 'REFUNDED', lastErrorCode: null };
      }
    }
    // Sin resolución se toca updated_at para que el lote siguiente avance a otros registros.
    const { count } = await this.db.payment.updateMany({
      where: { orderId, status },
      data: data ?? { updatedAt: new Date() },
    });
    if (data && count === 1) {
      this.logger.log('uncertain payment resolved', { orderId, from: status, to: data.status });
      return true;
    }
    return false;
  }
}
