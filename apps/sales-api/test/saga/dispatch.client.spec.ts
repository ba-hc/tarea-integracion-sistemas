import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SalesConfig } from '../../src/config/app-config.js';
import { HttpDispatchGateway } from '../../src/saga/dispatch.client.js';
import { closedPortUrl, StubServer } from './stub-server.js';

const ORDER_ID = '0f5b5c1e-2b4f-4b65-9a40-2f8f4b0b7a11';
const PART_ID = '3224288d-5201-477a-aa99-cb7cd1ba628d';
const TRACE_ID = '7c1c7d8e-3f0a-4f7e-8f63-61c1d2b4b9a0';
const ITEMS = [{ partId: PART_ID, quantity: 2 }];

function sagaConfig(dispatchBaseUrl: string, dispatchTimeoutMs = 300): Pick<SalesConfig, 'saga'> {
  return { saga: { dispatchBaseUrl, dispatchTimeoutMs } as SalesConfig['saga'] };
}

describe('HttpDispatchGateway (contrato interno de Despacho, contra un stub)', () => {
  const stub = new StubServer();
  let dispatch: HttpDispatchGateway;

  beforeAll(async () => {
    dispatch = new HttpDispatchGateway(sagaConfig(await stub.start()));
  });
  beforeEach(() => {
    stub.requests.length = 0;
  });
  afterAll(async () => {
    await stub.stop();
  });

  it('creates the dispatch with PUT and exactly the items of the sale', async () => {
    stub.reply = () => ({ status: 201, body: { orderId: ORDER_ID, status: 'CREATED', items: ITEMS } });
    await expect(dispatch.create(ORDER_ID, ITEMS, TRACE_ID)).resolves.toEqual({ kind: 'done', value: undefined });
    expect(stub.requests[0]).toMatchObject({
      method: 'PUT',
      url: `/internal/v1/dispatches/${ORDER_ID}`,
      body: { items: ITEMS },
    });
    expect(stub.requests[0]!.headers['x-trace-id']).toBe(TRACE_ID);
  });

  it.each([
    ['replay 200 CREATED', { status: 200, body: { orderId: ORDER_ID, status: 'CREATED' } }, 'done', undefined],
    ['induced failure before persisting', { status: 503, body: { code: 'DISPATCH_CREATE_REJECTED' } }, 'rejected', 'DISPATCH_UNAVAILABLE'],
    ['validation rejected', { status: 400, body: { code: 'VALIDATION_ERROR' } }, 'rejected', 'INTERNAL_ERROR'],
    ['generic 503', { status: 503, body: {} }, 'in_doubt', 'DISPATCH_UNAVAILABLE'],
    ['409 conflict', { status: 409, body: { code: 'DISPATCH_CONFLICT' } }, 'in_doubt', 'INTERNAL_ERROR'],
  ] as const)('maps %s', async (_name, reply, kind, code) => {
    stub.reply = () => reply;
    const outcome = await dispatch.create(ORDER_ID, ITEMS, TRACE_ID);
    expect(outcome.kind).toBe(kind);
    if (outcome.kind !== 'done') expect(outcome.error.code).toBe(code);
  });

  it('marks a slow creation as in doubt with DISPATCH_TIMEOUT', async () => {
    stub.reply = () => ({ status: 201, body: { orderId: ORDER_ID, status: 'CREATED' }, delayMs: 2_000 });
    await expect(dispatch.create(ORDER_ID, ITEMS, TRACE_ID)).resolves.toMatchObject({
      kind: 'in_doubt',
      error: { code: 'DISPATCH_TIMEOUT', status: 504 },
    });
  });

  it('treats a refused connection as a safe rejection', async () => {
    const down = new HttpDispatchGateway(sagaConfig(await closedPortUrl()));
    await expect(down.create(ORDER_ID, ITEMS, TRACE_ID)).resolves.toMatchObject({ kind: 'rejected', error: { code: 'DISPATCH_UNAVAILABLE' } });
  });

  it('cancels with POST and accepts 404 only for a creation in doubt', async () => {
    stub.reply = () => ({ status: 200, body: { orderId: ORDER_ID, status: 'CANCELLED', items: ITEMS } });
    await expect(dispatch.cancel(ORDER_ID, false, TRACE_ID)).resolves.toEqual({ kind: 'compensated' });
    expect(stub.requests[0]).toMatchObject({ method: 'POST', url: `/internal/v1/dispatches/${ORDER_ID}/cancel` });

    stub.reply = () => ({ status: 404, body: { code: 'NOT_FOUND' } });
    await expect(dispatch.cancel(ORDER_ID, true, TRACE_ID)).resolves.toEqual({ kind: 'compensated' });
    await expect(dispatch.cancel(ORDER_ID, false, TRACE_ID)).resolves.toMatchObject({ kind: 'retry' });

    stub.reply = () => ({ status: 500, body: {} });
    await expect(dispatch.cancel(ORDER_ID, false, TRACE_ID)).resolves.toMatchObject({ kind: 'retry', error: { code: 'DISPATCH_UNAVAILABLE' } });
  });
});
