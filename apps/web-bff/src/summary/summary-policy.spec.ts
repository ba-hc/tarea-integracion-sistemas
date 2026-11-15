import { describe, expect, it } from 'vitest';
import type {
  DispatchResult,
  PaymentResult,
  SourceAvailability,
} from '../sources/types.js';
import { summarize } from './summary-policy.js';

const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const PART_ID = '22222222-2222-4222-8222-222222222222';

const PAYMENT_DATA = { orderId: ORDER_ID, status: 'CHARGED' as const };
const DISPATCH_DATA = {
  orderId: ORDER_ID,
  status: 'CREATED' as const,
  items: [{ partId: PART_ID, quantity: 1 }],
};

const AVAILABILITIES: readonly SourceAvailability[] = [
  'available',
  'not_found',
  'unavailable',
  'timeout',
];

function paymentFor(availability: SourceAvailability): PaymentResult {
  return availability === 'available'
    ? { availability, data: PAYMENT_DATA }
    : { availability };
}

function dispatchFor(availability: SourceAvailability): DispatchResult {
  return availability === 'available'
    ? { availability, data: DISPATCH_DATA }
    : { availability };
}

describe('summary policy', () => {
  it('covers all 16 availability combinations', () => {
    for (const paymentAvailability of AVAILABILITIES) {
      for (const dispatchAvailability of AVAILABILITIES) {
        const outcome = summarize(
          ORDER_ID,
          paymentFor(paymentAvailability),
          dispatchFor(dispatchAvailability),
        );
        const anyAvailable = paymentAvailability === 'available' || dispatchAvailability === 'available';

        if (anyAvailable) {
          expect(outcome.kind).toBe('success');
          if (outcome.kind !== 'success') continue;
          expect(outcome.body.orderId).toBe(ORDER_ID);
          expect(outcome.body.partial).toBe(
            !(paymentAvailability === 'available' && dispatchAvailability === 'available'),
          );
          expect(outcome.body.payment.availability).toBe(paymentAvailability);
          expect(outcome.body.dispatch.availability).toBe(dispatchAvailability);
          if (paymentAvailability === 'available') {
            expect('data' in outcome.body.payment && outcome.body.payment.data).toEqual(PAYMENT_DATA);
          } else {
            expect('data' in outcome.body.payment).toBe(false);
          }
          if (dispatchAvailability === 'available') {
            expect('data' in outcome.body.dispatch && outcome.body.dispatch.data).toEqual(DISPATCH_DATA);
          } else {
            expect('data' in outcome.body.dispatch).toBe(false);
          }
          continue;
        }

        expect(outcome.kind).toBe('error');
        if (outcome.kind !== 'error') continue;
        const expectedStatus = paymentAvailability === 'timeout' || dispatchAvailability === 'timeout'
          ? 504
          : paymentAvailability === 'unavailable' || dispatchAvailability === 'unavailable'
            ? 503
            : 404;
        expect(outcome.error.status).toBe(expectedStatus);
        if (expectedStatus === 404) {
          expect(outcome.error.code).toBe('SUMMARY_NOT_FOUND');
          expect(outcome.error.details).toBeUndefined();
        } else {
          expect(outcome.error.details?.sources).toEqual({
            payment: paymentAvailability,
            dispatch: dispatchAvailability,
          });
        }
      }
    }
  });

  it('keeps DECLINED as available and partial false when dispatch is available', () => {
    const outcome = summarize(
      ORDER_ID,
      { availability: 'available', data: { orderId: ORDER_ID, status: 'DECLINED' } },
      dispatchFor('available'),
    );
    expect(outcome.kind).toBe('success');
    if (outcome.kind === 'success') {
      expect(outcome.body.partial).toBe(false);
      expect(outcome.body.payment).toEqual({
        availability: 'available',
        data: { orderId: ORDER_ID, status: 'DECLINED' },
      });
    }
  });

  it('never turns a missing payment into an approved charge', () => {
    const outcome = summarize(ORDER_ID, paymentFor('not_found'), dispatchFor('available'));
    expect(outcome.kind).toBe('success');
    if (outcome.kind === 'success') {
      expect(outcome.body.payment).toEqual({ availability: 'not_found' });
      expect('data' in outcome.body.payment).toBe(false);
      expect(JSON.stringify(outcome.body)).not.toContain('CHARGED');
    }
  });

  it('returns SUMMARY_NOT_FOUND without claiming the Sales order is missing', () => {
    const outcome = summarize(ORDER_ID, paymentFor('not_found'), dispatchFor('not_found'));
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.error).toEqual({
        status: 404,
        code: 'SUMMARY_NOT_FOUND',
        message: 'No summary sources found for this order',
      });
    }
  });
});
