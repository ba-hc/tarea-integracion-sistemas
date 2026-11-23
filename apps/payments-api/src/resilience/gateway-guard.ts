import { Inject, Injectable, Logger } from '@nestjs/common';
import { PAYMENTS_CONFIG } from '../tokens.js';
import type { PaymentsConfig } from '../config.js';
import { Bulkhead, type BulkheadSnapshot } from './bulkhead.js';
import { CircuitBreaker, type CallOutcome, type CircuitSnapshot } from './circuit-breaker.js';

export type RejectionReason = 'CIRCUIT_OPEN' | 'BULKHEAD_FULL';

export type Admission =
  | { readonly admitted: true; release(outcome: CallOutcome): void }
  | { readonly admitted: false; readonly reason: RejectionReason };

export interface GuardSnapshot {
  readonly circuitBreaker: CircuitSnapshot;
  readonly bulkhead: BulkheadSnapshot;
}

/**
 * Única puerta hacia la pasarela: primero el Circuit Breaker (rechazo
 * inmediato si está abierto) y después el Bulkhead (cupo de concurrencia).
 * Cada protección puede apagarse por configuración para el experimento.
 */
@Injectable()
export class GatewayGuard {
  private readonly logger = new Logger('GatewayGuard');
  private readonly breaker: CircuitBreaker;
  private readonly bulkhead: Bulkhead;

  constructor(@Inject(PAYMENTS_CONFIG) private readonly config: PaymentsConfig) {
    this.breaker = new CircuitBreaker(config.circuitBreaker, (from, to) => {
      this.logger.warn('circuit breaker state changed', { from, to });
    });
    this.bulkhead = new Bulkhead(config.bulkhead.maxConcurrent);
  }

  admit(): Admission {
    let token: number | undefined;
    if (this.config.circuitBreaker.enabled) {
      token = this.breaker.tryAcquire();
      if (token === undefined) return { admitted: false, reason: 'CIRCUIT_OPEN' };
    }
    if (this.config.bulkhead.enabled && !this.bulkhead.tryAcquire()) {
      if (token !== undefined) this.breaker.record(token, 'ignored');
      return { admitted: false, reason: 'BULKHEAD_FULL' };
    }
    let released = false;
    return {
      admitted: true,
      release: (outcome) => {
        if (released) return;
        released = true;
        if (this.config.bulkhead.enabled) this.bulkhead.release();
        if (token !== undefined) this.breaker.record(token, outcome);
      },
    };
  }

  snapshot(): GuardSnapshot {
    return {
      circuitBreaker: { enabled: this.config.circuitBreaker.enabled, ...this.breaker.snapshot() },
      bulkhead: { enabled: this.config.bulkhead.enabled, ...this.bulkhead.snapshot() },
    };
  }
}
