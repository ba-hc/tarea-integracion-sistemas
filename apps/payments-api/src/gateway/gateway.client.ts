import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PaymentsConfig } from '../config.js';
import type { CallOutcome } from '../resilience/circuit-breaker.js';
import { PAYMENTS_CONFIG } from '../tokens.js';

/** Clave estable del cobro de una venta en la pasarela. Se reutiliza en cada reintento. */
export const chargeKey = (orderId: string) => `charge-${orderId}`;
/** Clave estable del reembolso de una venta, distinta de la del cobro. */
export const refundKey = (orderId: string) => `refund-${orderId}`;

export type UncertainReason = 'timeout' | 'error' | 'unexpected';

export type ChargeResult =
  | { readonly kind: 'approved'; readonly chargeId: string }
  | { readonly kind: 'declined' }
  /** La clave fue anulada por un reembolso previo: no hay dinero retenido. */
  | { readonly kind: 'voided' }
  /** La pasarela confirmó que no aplicó nada (503 propio o conexión rechazada). */
  | { readonly kind: 'not_applied' }
  | { readonly kind: 'uncertain'; readonly reason: UncertainReason };

export type RefundResult =
  | { readonly kind: 'refunded' }
  | { readonly kind: 'voided' }
  | { readonly kind: 'not_refundable' }
  | { readonly kind: 'not_applied' }
  | { readonly kind: 'uncertain'; readonly reason: UncertainReason };

export type GatewayChargeStatus = 'APPROVED' | 'DECLINED' | 'REFUNDED' | 'VOIDED';

export type LookupResult =
  | { readonly kind: 'found'; readonly status: GatewayChargeStatus; readonly chargeId: string | null }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unavailable'; readonly reason: UncertainReason };

type RawResult =
  | { kind: 'response'; status: number; body: unknown }
  | { kind: 'not_sent' }
  | { kind: 'timeout' }
  | { kind: 'failed' };

const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);
const MAX_RESPONSE_BYTES = 64 * 1024;
const GATEWAY_STATUSES = new Set<string>(['APPROVED', 'DECLINED', 'REFUNDED', 'VOIDED']);

function record(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

function errorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const { code, cause, errors } = current as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof code === 'string') return code;
    current = Array.isArray(errors) && errors.length > 0 ? errors[0] : cause;
  }
  return undefined;
}

function isGatewayDown(result: RawResult): boolean {
  if (result.kind === 'not_sent') return true;
  return result.kind === 'response' && result.status === 503 && record(result.body).code === 'GATEWAY_UNAVAILABLE';
}

function uncertain(result: RawResult): UncertainReason {
  if (result.kind === 'timeout') return 'timeout';
  if (result.kind === 'response' && result.status < 500) return 'unexpected';
  return 'error';
}

/** Cómo cuenta cada resultado para el Circuit Breaker: sólo las fallas técnicas lo abren. */
export function breakerOutcome(result: ChargeResult | RefundResult | LookupResult): CallOutcome {
  if (result.kind === 'not_applied') return 'failure';
  if (result.kind === 'uncertain' || result.kind === 'unavailable') {
    return result.reason === 'unexpected' ? 'ignored' : 'failure';
  }
  return 'success';
}

/**
 * Cliente HTTP de la pasarela externa. Una llamada por operación, sin
 * reintentos, con un plazo que cubre conexión, cabeceras y cuerpo.
 */
@Injectable()
export class GatewayClient {
  private readonly logger = new Logger('PaymentGateway');

  constructor(@Inject(PAYMENTS_CONFIG) private readonly config: Pick<PaymentsConfig, 'gateway'>) {}

  async charge(orderId: string, amountMinor: number, currency: string, traceId: string): Promise<ChargeResult> {
    const key = chargeKey(orderId);
    const result = await this.call('charge', 'POST', '/v1/charges', { idempotencyKey: key, amountMinor, currency }, traceId, orderId);
    if (isGatewayDown(result)) return { kind: 'not_applied' };
    if (result.kind !== 'response' || result.status !== 200) return { kind: 'uncertain', reason: uncertain(result) };
    const body = record(result.body);
    if (body.idempotencyKey !== key) return { kind: 'uncertain', reason: 'unexpected' };
    if (body.status === 'APPROVED' && typeof body.chargeId === 'string') return { kind: 'approved', chargeId: body.chargeId };
    if (body.status === 'DECLINED') return { kind: 'declined' };
    if (body.status === 'VOIDED' || body.status === 'REFUNDED') return { kind: 'voided' };
    return { kind: 'uncertain', reason: 'unexpected' };
  }

  async refund(orderId: string, traceId: string): Promise<RefundResult> {
    const body = { idempotencyKey: refundKey(orderId), chargeIdempotencyKey: chargeKey(orderId) };
    const result = await this.call('refund', 'POST', '/v1/refunds', body, traceId, orderId);
    if (isGatewayDown(result)) return { kind: 'not_applied' };
    if (result.kind === 'response' && result.status === 409 && record(result.body).code === 'CHARGE_NOT_REFUNDABLE') {
      return { kind: 'not_refundable' };
    }
    if (result.kind !== 'response' || result.status !== 200) return { kind: 'uncertain', reason: uncertain(result) };
    const status = record(result.body).status;
    if (status === 'REFUNDED') return { kind: 'refunded' };
    if (status === 'VOIDED') return { kind: 'voided' };
    return { kind: 'uncertain', reason: 'unexpected' };
  }

  async lookup(orderId: string, traceId: string): Promise<LookupResult> {
    const key = chargeKey(orderId);
    const result = await this.call('lookup', 'GET', `/v1/charges/${encodeURIComponent(key)}`, undefined, traceId, orderId);
    if (result.kind === 'response' && result.status === 404 && record(result.body).code === 'CHARGE_NOT_FOUND') {
      return { kind: 'missing' };
    }
    if (result.kind !== 'response' || result.status !== 200) return { kind: 'unavailable', reason: uncertain(result) };
    const body = record(result.body);
    if (body.idempotencyKey !== key || typeof body.status !== 'string' || !GATEWAY_STATUSES.has(body.status)) {
      return { kind: 'unavailable', reason: 'unexpected' };
    }
    return {
      kind: 'found',
      status: body.status as GatewayChargeStatus,
      chargeId: typeof body.chargeId === 'string' ? body.chargeId : null,
    };
  }

  private async call(
    operation: 'charge' | 'refund' | 'lookup',
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    traceId: string,
    orderId: string,
  ): Promise<RawResult> {
    const startedAt = performance.now();
    const result = await this.send(method, path, body, traceId);
    this.logger.log('gateway call finished', {
      operation,
      result: result.kind,
      status: result.kind === 'response' ? result.status : undefined,
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
      orderId,
      traceId,
    });
    return result;
  }

  private async send(method: 'GET' | 'POST', path: string, body: unknown, traceId: string): Promise<RawResult> {
    const signal = AbortSignal.timeout(this.config.gateway.timeoutMs);
    const headers: Record<string, string> = { accept: 'application/json', 'x-trace-id': traceId };
    if (body !== undefined) headers['content-type'] = 'application/json';
    try {
      const init: RequestInit = { method, headers, redirect: 'manual', signal };
      if (body !== undefined) init.body = JSON.stringify(body);
      const response = await fetch(`${this.config.gateway.baseUrl}${path}`, init);
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) return { kind: 'failed' };
      let parsed: unknown;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : undefined;
      } catch {
        if (response.status < 300) return { kind: 'failed' };
      }
      return { kind: 'response', status: response.status, body: parsed };
    } catch (error) {
      if (signal.aborted) return { kind: 'timeout' };
      const code = errorCode(error);
      if (code !== undefined && NOT_SENT_CODES.has(code)) return { kind: 'not_sent' };
      return { kind: 'failed' };
    }
  }
}
