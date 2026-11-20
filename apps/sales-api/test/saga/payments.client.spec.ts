import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SalesConfig } from '../../src/config/app-config.js';
import { HttpPaymentsGateway } from '../../src/saga/payments.client.js';
import { closedPortUrl, StubServer } from './stub-server.js';

const ORDER_ID = '0f5b5c1e-2b4f-4b65-9a40-2f8f4b0b7a11';
const TRACE_ID = '7c1c7d8e-3f0a-4f7e-8f63-61c1d2b4b9a0';

function sagaConfig(paymentsBaseUrl: string, paymentsTimeoutMs = 300): Pick<SalesConfig, 'saga'> {
  return { saga: { paymentsBaseUrl, paymentsTimeoutMs } as SalesConfig['saga'] };
}

describe('HttpPaymentsGateway (contrato propuesto de Pagos, contra un stub)', () => {
  const stub = new StubServer();
  let payments: HttpPaymentsGateway;

  beforeAll(async () => {
    payments = new HttpPaymentsGateway(sagaConfig(await stub.start()));
  });
  beforeEach(() => {
    stub.requests.length = 0;
  });
  afterAll(async () => {
    await stub.stop();
  });

  it('sends one idempotent PUT per order with amount, currency and trace id', async () => {
    stub.reply = () => ({ status: 201, body: { orderId: ORDER_ID, status: 'CHARGED', amountMinor: 20000, currency: 'CLP' } });

    await expect(payments.charge(ORDER_ID, 20_000, 'CLP', TRACE_ID)).resolves.toEqual({ kind: 'done', value: undefined });
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]).toMatchObject({
      method: 'PUT',
      url: `/internal/v1/payments/${ORDER_ID}`,
      body: { amountMinor: 20_000, currency: 'CLP' },
    });
    expect(stub.requests[0]!.headers['x-trace-id']).toBe(TRACE_ID);
  });

  it('treats a replayed charge (200 CHARGED) as done', async () => {
    stub.reply = () => ({ status: 200, body: { orderId: ORDER_ID, status: 'CHARGED' } });
    await expect(payments.charge(ORDER_ID, 1, 'CLP', TRACE_ID)).resolves.toMatchObject({ kind: 'done' });
  });

  it.each([
    ['422 decline', { status: 422, body: { code: 'PAYMENT_DECLINED' } }, 'rejected', 'PAYMENT_DECLINED', 422],
    ['replayed decline', { status: 200, body: { orderId: ORDER_ID, status: 'DECLINED' } }, 'rejected', 'PAYMENT_DECLINED', 422],
    ['circuit open / bulkhead full', { status: 503, body: { code: 'PAYMENT_CHARGE_REJECTED' } }, 'rejected', 'PAYMENT_UNAVAILABLE', 503],
    ['validation rejected', { status: 400, body: { code: 'VALIDATION_ERROR' } }, 'rejected', 'INTERNAL_ERROR', 500],
    ['202 pending', { status: 202, body: { orderId: ORDER_ID, status: 'PENDING' } }, 'in_doubt', 'PAYMENT_TIMEOUT', 504],
    ['generic 503', { status: 503, body: { code: 'SOMETHING' } }, 'in_doubt', 'PAYMENT_UNAVAILABLE', 503],
    ['500', { status: 500, body: {} }, 'in_doubt', 'PAYMENT_UNAVAILABLE', 503],
    ['409 amount conflict', { status: 409, body: { code: 'PAYMENT_CONFLICT' } }, 'in_doubt', 'INTERNAL_ERROR', 500],
    ['200 for another order', { status: 200, body: { orderId: TRACE_ID, status: 'CHARGED' } }, 'in_doubt', 'INTERNAL_ERROR', 500],
  ] as const)('maps %s to %s %s', async (_name, reply, kind, code, status) => {
    stub.reply = () => reply;
    const outcome = await payments.charge(ORDER_ID, 1, 'CLP', TRACE_ID);
    expect(outcome.kind).toBe(kind);
    if (outcome.kind === 'done') throw new Error('unexpected done');
    expect(outcome.error.code).toBe(code);
    expect(outcome.error.getStatus()).toBe(status);
  });

  it('marks a slow charge as in doubt with PAYMENT_TIMEOUT after the deadline', async () => {
    stub.reply = () => ({ status: 201, body: { orderId: ORDER_ID, status: 'CHARGED' }, delayMs: 2_000 });
    const startedAt = Date.now();
    const outcome = await payments.charge(ORDER_ID, 1, 'CLP', TRACE_ID);
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(outcome).toMatchObject({ kind: 'in_doubt', error: { code: 'PAYMENT_TIMEOUT' } });
    expect(stub.requests).toHaveLength(1);
  });

  it('treats a refused connection as a safe rejection (the command was never sent)', async () => {
    const down = new HttpPaymentsGateway(sagaConfig(await closedPortUrl()));
    await expect(down.charge(ORDER_ID, 1, 'CLP', TRACE_ID)).resolves.toMatchObject({
      kind: 'rejected',
      error: { code: 'PAYMENT_UNAVAILABLE' },
    });
    await expect(down.refund(ORDER_ID, false, TRACE_ID)).resolves.toMatchObject({
      kind: 'retry',
      error: { code: 'PAYMENT_UNAVAILABLE' },
    });
  });

  describe('refund', () => {
    it('confirms a REFUNDED payment', async () => {
      stub.reply = () => ({ status: 200, body: { orderId: ORDER_ID, status: 'REFUNDED' } });
      await expect(payments.refund(ORDER_ID, false, TRACE_ID)).resolves.toEqual({ kind: 'compensated' });
      expect(stub.requests[0]).toMatchObject({ method: 'POST', url: `/internal/v1/payments/${ORDER_ID}/refund` });
    });

    it('accepts 404 only when the charge itself was in doubt', async () => {
      stub.reply = () => ({ status: 404, body: { code: 'NOT_FOUND' } });
      await expect(payments.refund(ORDER_ID, true, TRACE_ID)).resolves.toEqual({ kind: 'compensated' });
      await expect(payments.refund(ORDER_ID, false, TRACE_ID)).resolves.toMatchObject({ kind: 'retry' });
    });

    it('on 409 consults the payment and accepts a DECLINED charge as nothing to refund', async () => {
      stub.reply = (request) => request.method === 'GET'
        ? { status: 200, body: { orderId: ORDER_ID, status: 'DECLINED' } }
        : { status: 409, body: { code: 'PAYMENT_NOT_REFUNDABLE' } };
      await expect(payments.refund(ORDER_ID, true, TRACE_ID)).resolves.toEqual({ kind: 'compensated' });
      expect(stub.requests.map((request) => request.method)).toEqual(['POST', 'GET']);
    });

    it('keeps a pending refund (202) or an unavailable Payments as retry', async () => {
      stub.reply = () => ({ status: 202, body: { orderId: ORDER_ID, status: 'REFUND_PENDING' } });
      await expect(payments.refund(ORDER_ID, false, TRACE_ID)).resolves.toMatchObject({ kind: 'retry', error: { code: 'PAYMENT_TIMEOUT' } });
      stub.reply = () => ({ status: 503, body: {} });
      await expect(payments.refund(ORDER_ID, false, TRACE_ID)).resolves.toMatchObject({ kind: 'retry', error: { code: 'PAYMENT_UNAVAILABLE' } });
    });
  });
});
