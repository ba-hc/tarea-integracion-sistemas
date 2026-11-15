import { describe, expect, it } from 'vitest';
import type {
  DispatchResult,
  DispatchSource,
  PaymentResult,
  PaymentsSource,
} from '../sources/types.js';
import { SummaryService } from './summary.service.js';

const ORDER_ID = '11111111-1111-4111-8111-111111111111';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('summary service', () => {
  it('starts both sources before awaiting either result', async () => {
    const paymentDeferred = deferred<PaymentResult>();
    const dispatchDeferred = deferred<DispatchResult>();
    const calls: string[] = [];

    const payments: PaymentsSource = {
      get: (orderId, traceId) => {
        calls.push(`payment:${orderId}:${traceId}`);
        return paymentDeferred.promise;
      },
    };
    const dispatch: DispatchSource = {
      get: (orderId, traceId) => {
        calls.push(`dispatch:${orderId}:${traceId}`);
        return dispatchDeferred.promise;
      },
    };

    const service = new SummaryService(payments, dispatch);
    const resultPromise = service.summarize(ORDER_ID, 'trace-id');
    expect(calls).toEqual([
      `payment:${ORDER_ID}:trace-id`,
      `dispatch:${ORDER_ID}:trace-id`,
    ]);

    paymentDeferred.resolve({
      availability: 'available',
      data: { orderId: ORDER_ID, status: 'CHARGED' },
    });
    dispatchDeferred.resolve({
      availability: 'available',
      data: {
        orderId: ORDER_ID,
        status: 'CREATED',
        items: [{ partId: '22222222-2222-4222-8222-222222222222', quantity: 1 }],
      },
    });

    const outcome = await resultPromise;
    expect(outcome.kind).toBe('success');
    if (outcome.kind === 'success') expect(outcome.body.partial).toBe(false);
  });

  it('keeps a fast available source when the other times out', async () => {
    const paymentDeferred = deferred<PaymentResult>();
    const dispatchDeferred = deferred<DispatchResult>();
    const service = new SummaryService(
      { get: () => paymentDeferred.promise },
      { get: () => dispatchDeferred.promise },
    );
    const resultPromise = service.summarize(ORDER_ID, 'trace-id');

    paymentDeferred.resolve({
      availability: 'available',
      data: { orderId: ORDER_ID, status: 'CHARGED' },
    });
    dispatchDeferred.resolve({ availability: 'timeout' });

    const outcome = await resultPromise;
    expect(outcome.kind).toBe('success');
    if (outcome.kind === 'success') {
      expect(outcome.body.partial).toBe(true);
      expect(outcome.body.payment.availability).toBe('available');
      expect(outcome.body.dispatch.availability).toBe('timeout');
    }
  });
});
