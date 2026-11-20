import { Inject, Injectable, Logger } from '@nestjs/common';
import { SALES_CONFIG, type SalesConfig } from '../config/app-config.js';
import { errorCodeOf, httpCall, statusOf, type HttpCallResult } from './http-call.js';
import {
  DISPATCH_TIMEOUT,
  DISPATCH_UNAVAILABLE,
  INTERNAL_ERROR,
  type CompensationOutcome,
  type StepOutcome,
} from './saga-outcome.js';

export const DISPATCH_GATEWAY = Symbol('DISPATCH_GATEWAY');

/**
 * Frontera de Sales hacia Despacho (paso 3 de la Saga). Contrato REST interno
 * de T2-INTERNAL-CONTRACTS.md, implementado por P1 en apps/dispatch-api.
 */
export interface DispatchGateway {
  /** Crea el despacho de `orderId`. Repetir los mismos ítems devuelve el mismo despacho. */
  create(orderId: string, items: Array<{ partId: string; quantity: number }>, traceId: string): Promise<StepOutcome>;
  /** Cancela el despacho. `wasInDoubt`: un 404 confirma que nunca se creó. */
  cancel(orderId: string, wasInDoubt: boolean, traceId: string): Promise<CompensationOutcome>;
}

/** Despacho garantiza que rechazó la creación antes de escribir (modo de falla inducida). */
const CREATE_REJECTED_CODE = 'DISPATCH_CREATE_REJECTED';

function unavailableOrTimeout(result: HttpCallResult) {
  return result.kind === 'timeout' ? DISPATCH_TIMEOUT() : DISPATCH_UNAVAILABLE();
}

@Injectable()
export class HttpDispatchGateway implements DispatchGateway {
  private readonly logger = new Logger('DispatchGateway');

  constructor(@Inject(SALES_CONFIG) private readonly config: Pick<SalesConfig, 'saga'>) {}

  async create(orderId: string, items: Array<{ partId: string; quantity: number }>, traceId: string): Promise<StepOutcome> {
    const result = await this.call('PUT', `/internal/v1/dispatches/${orderId}`, { items }, traceId, orderId);
    if (result.kind === 'not_sent') return { kind: 'rejected', error: DISPATCH_UNAVAILABLE() };
    if (result.kind !== 'response') return { kind: 'in_doubt', error: unavailableOrTimeout(result) };

    const { status, body } = result;
    if ((status === 200 || status === 201) && statusOf(body, orderId) === 'CREATED') {
      return { kind: 'done', value: undefined };
    }
    if (status === 503 && errorCodeOf(body) === CREATE_REJECTED_CODE) {
      return { kind: 'rejected', error: DISPATCH_UNAVAILABLE() };
    }
    if (status === 400) return { kind: 'rejected', error: INTERNAL_ERROR() };
    // 409 DISPATCH_CONFLICT/CANCELLED u otra respuesta inesperada: inconsistencia.
    if (status < 500) return { kind: 'in_doubt', error: INTERNAL_ERROR() };
    return { kind: 'in_doubt', error: DISPATCH_UNAVAILABLE() };
  }

  async cancel(orderId: string, wasInDoubt: boolean, traceId: string): Promise<CompensationOutcome> {
    const result = await this.call('POST', `/internal/v1/dispatches/${orderId}/cancel`, undefined, traceId, orderId);
    if (result.kind !== 'response') return { kind: 'retry', error: unavailableOrTimeout(result) };

    const { status, body } = result;
    if (status === 200 && statusOf(body, orderId) === 'CANCELLED') return { kind: 'compensated' };
    if (status === 404) {
      if (wasInDoubt) return { kind: 'compensated' };
      this.logger.error('dispatch confirmed by the saga is unknown to Dispatch', { orderId, traceId });
      return { kind: 'retry', error: INTERNAL_ERROR() };
    }
    if (status < 500) return { kind: 'retry', error: INTERNAL_ERROR() };
    return { kind: 'retry', error: DISPATCH_UNAVAILABLE() };
  }

  private async call(
    method: 'PUT' | 'POST',
    path: string,
    body: unknown,
    traceId: string,
    orderId: string,
  ): Promise<HttpCallResult> {
    const startedAt = performance.now();
    const result = await httpCall({
      baseUrl: this.config.saga.dispatchBaseUrl,
      method,
      path,
      body,
      timeoutMs: this.config.saga.dispatchTimeoutMs,
      traceId,
    });
    this.logger.log('dispatch call finished', {
      method,
      operation: method === 'PUT' ? 'create' : 'cancel',
      result: result.kind,
      status: result.kind === 'response' ? result.status : undefined,
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
      orderId,
      traceId,
    });
    return result;
  }
}
