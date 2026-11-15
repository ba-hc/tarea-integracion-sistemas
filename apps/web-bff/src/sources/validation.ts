import type { DispatchStatus, PaymentStatus } from './types.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseJsonBody(body: Buffer): unknown {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function isPaymentStatus(value: unknown): value is PaymentStatus {
  return value === 'CHARGED'
    || value === 'DECLINED'
    || value === 'REFUNDED'
    || value === 'PENDING'
    || value === 'REFUND_PENDING';
}

export function isDispatchStatus(value: unknown): value is DispatchStatus {
  return value === 'CREATED' || value === 'CANCELLED';
}
