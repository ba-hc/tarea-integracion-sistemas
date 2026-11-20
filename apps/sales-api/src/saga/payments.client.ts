import { Inject, Injectable, Logger } from '@nestjs/common';
import { SALES_CONFIG, type SalesConfig } from '../config/app-config.js';
import { errorCodeOf, httpCall, statusOf, type HttpCallResult } from './http-call.js';
import {
  INTERNAL_ERROR,
  PAYMENT_DECLINED,
  PAYMENT_TIMEOUT,
  PAYMENT_UNAVAILABLE,
  type CompensationOutcome,
  type StepOutcome,
} from './saga-outcome.js';

export const PAYMENTS_GATEWAY = Symbol('PAYMENTS_GATEWAY');

/**
 * Frontera de Sales hacia Pagos (paso 2 de la Saga).
 *
 * El contrato REST interno es la propuesta de T2-INTERNAL-CONTRACTS.md, más
 * el código `PAYMENT_CHARGE_REJECTED` documentado en docs/t2/P3-SAGA.md.
 * Pagos (P2) está pendiente de integración: estas reglas se prueban contra un
 * stub HTTP.
 */
export interface PaymentsGateway {
  /** Cobra una sola vez por `orderId`. Repetir el mismo cobro no vuelve a cobrar. */
  charge(orderId: string, amountMinor: number, currency: string, traceId: string): Promise<StepOutcome>;
  /**
   * Reembolsa el cobro de `orderId`. `wasInDoubt` indica que no sabemos si el
   * cobro llegó a aplicarse: entonces un 404 confirma que no hay nada que
   * devolver.
   */
  refund(orderId: string, wasInDoubt: boolean, traceId: string): Promise<CompensationOutcome>;
}

/** Pagos rechazó el cobro antes de contactar a la pasarela (circuito abierto o bulkhead lleno). */
const CHARGE_REJECTED_CODE = 'PAYMENT_CHARGE_REJECTED';

function unavailableOrTimeout(result: HttpCallResult) {
  return result.kind === 'timeout' ? PAYMENT_TIMEOUT() : PAYMENT_UNAVAILABLE();
}

@Injectable()
export class HttpPaymentsGateway implements PaymentsGateway {
  private readonly logger = new Logger('PaymentsGateway');

  constructor(@Inject(SALES_CONFIG) private readonly config: Pick<SalesConfig, 'saga'>) {}

  async charge(orderId: string, amountMinor: number, currency: string, traceId: string): Promise<StepOutcome> {
    const result = await this.call('PUT', `/internal/v1/payments/${orderId}`, { amountMinor, currency }, traceId, orderId);
    if (result.kind === 'not_sent') return { kind: 'rejected', error: PAYMENT_UNAVAILABLE() };
    if (result.kind !== 'response') return { kind: 'in_doubt', error: unavailableOrTimeout(result) };

    const { status, body } = result;
    if (status === 200 || status === 201) {
      const paymentStatus = statusOf(body, orderId);
      if (paymentStatus === 'CHARGED') return { kind: 'done', value: undefined };
      if (paymentStatus === 'DECLINED') return { kind: 'rejected', error: PAYMENT_DECLINED() };
      return { kind: 'in_doubt', error: INTERNAL_ERROR() };
    }
    // 202 PENDING: la pasarela todavía no confirma el cobro.
    if (status === 202) return { kind: 'in_doubt', error: PAYMENT_TIMEOUT() };
    if (status === 422) return { kind: 'rejected', error: PAYMENT_DECLINED() };
    if (status === 503 && errorCodeOf(body) === CHARGE_REJECTED_CODE) {
      return { kind: 'rejected', error: PAYMENT_UNAVAILABLE() };
    }
    // 400: Pagos validó y rechazó el comando sin aplicarlo; es un defecto de Sales.
    if (status === 400) return { kind: 'rejected', error: INTERNAL_ERROR() };
    // 409 (otro importe para la misma venta) u otro 4xx: inconsistencia, no se sabe qué quedó.
    if (status < 500) return { kind: 'in_doubt', error: INTERNAL_ERROR() };
    return { kind: 'in_doubt', error: PAYMENT_UNAVAILABLE() };
  }

  async refund(orderId: string, wasInDoubt: boolean, traceId: string): Promise<CompensationOutcome> {
    const result = await this.call('POST', `/internal/v1/payments/${orderId}/refund`, undefined, traceId, orderId);
    if (result.kind !== 'response') return { kind: 'retry', error: unavailableOrTimeout(result) };

    const { status, body } = result;
    if (status === 200 && statusOf(body, orderId) === 'REFUNDED') return { kind: 'compensated' };
    if (status === 202) return { kind: 'retry', error: PAYMENT_TIMEOUT() };
    if (status === 404) {
      if (wasInDoubt) return { kind: 'compensated' };
      // Teníamos confirmado un cobro que Pagos no conoce: no se descarta, se reintenta y se registra.
      this.logger.error('payment confirmed by the saga is unknown to Payments', { orderId, traceId });
      return { kind: 'retry', error: INTERNAL_ERROR() };
    }
    if (status === 409) {
      // El estado no permite reembolsar: si el cobro fue rechazado no hay nada que devolver.
      const current = await this.call('GET', `/internal/v1/payments/${orderId}`, undefined, traceId, orderId);
      if (current.kind === 'response' && current.status === 200 && statusOf(current.body, orderId) === 'DECLINED') {
        return { kind: 'compensated' };
      }
      return { kind: 'retry', error: PAYMENT_UNAVAILABLE() };
    }
    if (status < 500) return { kind: 'retry', error: INTERNAL_ERROR() };
    return { kind: 'retry', error: PAYMENT_UNAVAILABLE() };
  }

  private async call(
    method: 'GET' | 'PUT' | 'POST',
    path: string,
    body: unknown,
    traceId: string,
    orderId: string,
  ): Promise<HttpCallResult> {
    const startedAt = performance.now();
    const result = await httpCall({
      baseUrl: this.config.saga.paymentsBaseUrl,
      method,
      path,
      body,
      timeoutMs: this.config.saga.paymentsTimeoutMs,
      traceId,
    });
    this.logger.log('payments call finished', {
      method,
      operation: path.endsWith('/refund') ? 'refund' : method === 'PUT' ? 'charge' : 'get',
      result: result.kind,
      status: result.kind === 'response' ? result.status : undefined,
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
      orderId,
      traceId,
    });
    return result;
  }
}
