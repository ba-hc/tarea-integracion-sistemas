import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerResponse } from 'node:http';
import type { BffConfig } from '../src/config/bff-config.js';
import { isUuid } from '../src/http/uuid.js';
import {
  jsonResponse,
  MemoryLogger,
  rawRequest,
  request,
  startBff,
  startStubServer,
  testConfig,
  textResponse,
  type BffHandle,
  type StubRequest,
  type StubServer,
} from './helpers.js';

const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const ORDER_ID_UPPER = ORDER_ID.toUpperCase();
const OTHER_ORDER_ID = '33333333-3333-4333-8333-333333333333';
const PART_ID = '22222222-2222-4222-8222-222222222222';
const TRACE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PAYMENT_STATUSES = ['CHARGED', 'DECLINED', 'REFUNDED', 'PENDING', 'REFUND_PENDING'] as const;

function defaultPayments(_request: StubRequest, response: ServerResponse): void {
  jsonResponse(response, 200, {
    orderId: ORDER_ID,
    status: 'CHARGED',
    amountMinor: 100,
    currency: 'USD',
    extra: 'drop-me',
  });
}

function defaultDispatch(_request: StubRequest, response: ServerResponse): void {
  jsonResponse(response, 200, {
    orderId: ORDER_ID,
    status: 'CREATED',
    items: [{ partId: PART_ID, quantity: 2, extra: 'drop-me' }],
    extra: 'drop-me',
  });
}

function summaryPath(orderId = ORDER_ID): string {
  return `/web/v1/orders/${orderId}/summary`;
}

function rawHeader(raw: string, name: string): string | undefined {
  const match = new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(raw);
  return match?.[1]?.trim();
}

describe('web BFF integration', () => {
  let payments: StubServer;
  let dispatch: StubServer;
  let config: BffConfig;
  let bff: BffHandle;
  let logger: MemoryLogger;

  async function restart(overrides: Partial<BffConfig> = {}): Promise<void> {
    await bff.close();
    config = { ...config, ...overrides };
    bff = await startBff(config, { logger });
  }

  beforeEach(async () => {
    payments = await startStubServer(defaultPayments);
    dispatch = await startStubServer(defaultDispatch);
    config = testConfig(payments.url, dispatch.url);
    logger = new MemoryLogger();
    bff = await startBff(config, { logger });
  });

  afterEach(async () => {
    await bff.close();
    await payments.close();
    await dispatch.close();
  });

  it('serves its own health without consulting sources', async () => {
    const response = await request(bff.url, '/health');
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ status: 'ok', service: 'web-bff' });
    expect(isUuid(response.headers.get('x-trace-id'))).toBe(true);
    expect(response.headers.get('x-powered-by')).toBeNull();
    expect(payments.requests).toHaveLength(0);
    expect(dispatch.requests).toHaveLength(0);
  });

  it('returns a normalized summary and drops upstream extras', async () => {
    payments.setHandler((_request, response) => {
      jsonResponse(response, 200, {
        orderId: ORDER_ID_UPPER,
        status: 'CHARGED',
        amountMinor: 100,
        currency: 'USD',
        extra: 'drop-me',
      });
    });
    dispatch.setHandler((_request, response) => {
      jsonResponse(response, 200, {
        orderId: ORDER_ID_UPPER,
        status: 'CREATED',
        items: [{ partId: PART_ID.toUpperCase(), quantity: 2, extra: 'drop-me' }],
        extra: 'drop-me',
      });
    });

    const response = await request(bff.url, `${summaryPath(ORDER_ID_UPPER)}?ignored=1`, {
      headers: { 'X-Trace-Id': TRACE_ID },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('x-trace-id')).toBe(TRACE_ID);
    expect(response.json).toEqual({
      orderId: ORDER_ID,
      partial: false,
      payment: {
        availability: 'available',
        data: { orderId: ORDER_ID, status: 'CHARGED' },
      },
      dispatch: {
        availability: 'available',
        data: {
          orderId: ORDER_ID,
          status: 'CREATED',
          items: [{ partId: PART_ID, quantity: 2 }],
        },
      },
    });
    expect(JSON.stringify(response.json)).not.toContain('amountMinor');
    expect(JSON.stringify(response.json)).not.toContain('currency');
    expect(JSON.stringify(response.json)).not.toContain('drop-me');

    expect(payments.requests).toHaveLength(1);
    expect(dispatch.requests).toHaveLength(1);
    expect(payments.requests[0]?.url).toBe(`/internal/v1/payments/${ORDER_ID}`);
    expect(dispatch.requests[0]?.url).toBe(`/internal/v1/dispatches/${ORDER_ID}`);
    expect(payments.requests[0]?.headers['x-trace-id']).toBe(TRACE_ID);
    expect(dispatch.requests[0]?.headers['x-trace-id']).toBe(TRACE_ID);
    expect(payments.requests[0]?.headers.accept).toBe('application/json');
    expect(dispatch.requests[0]?.headers.accept).toBe('application/json');
  });

  it.each(PAYMENT_STATUSES)('accepts payment status %s as available', async (status) => {
    payments.setHandler((_request, response) => {
      jsonResponse(response, 200, { orderId: ORDER_ID, status });
    });
    const response = await request(bff.url, summaryPath());
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({
      partial: false,
      payment: { availability: 'available', data: { orderId: ORDER_ID, status } },
      dispatch: { availability: 'available' },
    });
  });

  it.each(['CREATED', 'CANCELLED'] as const)('accepts dispatch status %s as available', async (status) => {
    dispatch.setHandler((_request, response) => {
      jsonResponse(response, 200, {
        orderId: ORDER_ID,
        status,
        items: [{ partId: PART_ID, quantity: 1 }],
      });
    });
    const response = await request(bff.url, summaryPath());
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({
      partial: false,
      payment: { availability: 'available' },
      dispatch: { availability: 'available', data: { orderId: ORDER_ID, status } },
    });
  });

  it('keeps a missing payment as not_found and never as CHARGED', async () => {
    payments.setHandler((_request, response) => {
      jsonResponse(response, 404, { code: 'NOT_FOUND', message: 'not found', traceId: TRACE_ID });
    });
    const response = await request(bff.url, summaryPath());
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({
      partial: true,
      payment: { availability: 'not_found' },
      dispatch: { availability: 'available' },
    });
    expect(JSON.stringify(response.json)).not.toContain('CHARGED');
    expect(response.text).not.toContain('not found');
  });

  it('keeps a missing dispatch as not_found while payment is available', async () => {
    dispatch.setHandler((_request, response) => {
      jsonResponse(response, 404, { code: 'NOT_FOUND', message: 'not found' });
    });
    const response = await request(bff.url, summaryPath());
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({
      partial: true,
      payment: { availability: 'available' },
      dispatch: { availability: 'not_found' },
    });
  });

  it('returns SUMMARY_NOT_FOUND only when both sources are not_found', async () => {
    payments.setHandler((_request, response) => jsonResponse(response, 404, { code: 'NOT_FOUND' }));
    dispatch.setHandler((_request, response) => jsonResponse(response, 404, { code: 'NOT_FOUND' }));
    const response = await request(bff.url, summaryPath());
    expect(response.status).toBe(404);
    expect(response.json).toEqual({
      code: 'SUMMARY_NOT_FOUND',
      message: 'No summary sources found for this order',
      traceId: response.headers.get('x-trace-id'),
    });
    expect(JSON.stringify(response.json)).not.toContain('sales');
  });

  it.each([503, 504])('treats an upstream HTTP %i as unavailable, not timeout', async (status) => {
    payments.setHandler((_request, response) => jsonResponse(response, status, { code: 'UPSTREAM_FAILURE' }));
    dispatch.setHandler((_request, response) => jsonResponse(response, 404, { code: 'NOT_FOUND' }));
    const response = await request(bff.url, summaryPath());
    expect(response.status).toBe(503);
    expect(response.json).toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
      details: { sources: { payment: 'unavailable', dispatch: 'not_found' } },
    });
  });

  it.each([503, 504])('maps both upstream HTTP %i failures to 503', async (status) => {
    payments.setHandler((_request, response) => jsonResponse(response, status, { code: 'FAILURE' }));
    dispatch.setHandler((_request, response) => jsonResponse(response, status, { code: 'FAILURE' }));
    const response = await request(bff.url, summaryPath());
    expect(response.status).toBe(503);
    expect(response.json).toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
      details: { sources: { payment: 'unavailable', dispatch: 'unavailable' } },
    });
  });

  it.each([503, 504])('maps an upstream dispatch HTTP %i to unavailable', async (status) => {
    dispatch.setHandler((_request, response) => jsonResponse(response, status, { code: 'FAILURE' }));
    const response = await request(bff.url, summaryPath());
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({
      partial: true,
      payment: { availability: 'available' },
      dispatch: { availability: 'unavailable' },
    });
  });

  it('returns 504 when a source times out while the other is not_found', async () => {
    await restart({ sourceTimeoutMs: 50 });
    payments.setHandler(() => {
      // Never send headers.
    });
    dispatch.setHandler((_request, response) => jsonResponse(response, 404, { code: 'NOT_FOUND' }));
    const response = await request(bff.url, summaryPath());
    expect(response.status).toBe(504);
    expect(response.json).toMatchObject({
      code: 'UPSTREAM_TIMEOUT',
      details: { sources: { payment: 'timeout', dispatch: 'not_found' } },
    });
    expect(payments.requests).toHaveLength(1);
    expect(dispatch.requests).toHaveLength(1);
  });

  it('times out a slow response body and does not retry', async () => {
    await restart({ sourceTimeoutMs: 50 });
    payments.setHandler((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{"orderId":');
      setTimeout(() => {
        if (!response.destroyed) response.end(`"${ORDER_ID}","status":"CHARGED"}`);
      }, 250);
    });
    const response = await request(bff.url, summaryPath());
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({
      partial: true,
      payment: { availability: 'timeout' },
      dispatch: { availability: 'available' },
    });
    expect(payments.requests).toHaveLength(1);
    expect(dispatch.requests).toHaveLength(1);
  });

  it('times out both sources in parallel with 504', async () => {
    await restart({ sourceTimeoutMs: 50 });
    payments.setHandler(() => {
      // Never send headers.
    });
    dispatch.setHandler(() => {
      // Never send headers.
    });
    const response = await request(bff.url, summaryPath());
    expect(response.status).toBe(504);
    expect(response.json).toMatchObject({
      code: 'UPSTREAM_TIMEOUT',
      details: { sources: { payment: 'timeout', dispatch: 'timeout' } },
    });
    expect(payments.requests).toHaveLength(1);
    expect(dispatch.requests).toHaveLength(1);
  });

  it('returns a 404 source result promptly even when its body never ends', async () => {
    payments.setHandler((_request, response) => {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.write('{"code":');
    });
    const response = await request(bff.url, summaryPath());
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({
      partial: true,
      payment: { availability: 'not_found' },
      dispatch: { availability: 'available' },
    });
  });

  it('rejects an invalid order UUID without calling sources', async () => {
    const response = await request(bff.url, summaryPath('not-a-uuid'));
    expect(response.status).toBe(400);
    expect(response.json).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect((response.json as { traceId: string }).traceId).toBe(response.headers.get('x-trace-id'));
    expect(payments.requests).toHaveLength(0);
    expect(dispatch.requests).toHaveLength(0);
  });

  it('rejects a GET with a request body without calling sources', async () => {
    const raw = await rawRequest(
      bff.url,
      `GET ${summaryPath()} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`,
    );
    expect(raw.startsWith('HTTP/1.1 400')).toBe(true);
    expect(payments.requests).toHaveLength(0);
    expect(dispatch.requests).toHaveLength(0);
  });

  it('rejects a GET health body without calling sources', async () => {
    const raw = await rawRequest(
      bff.url,
      'GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}',
    );
    expect(raw.startsWith('HTTP/1.1 400')).toBe(true);
    expect(payments.requests).toHaveLength(0);
    expect(dispatch.requests).toHaveLength(0);
  });

  it('denies unknown paths and wrong methods without exposing internal routes', async () => {
    const unknown = await request(bff.url, '/internal/v1/payments/x');
    expect(unknown.status).toBe(404);
    expect((unknown.json as { code: string }).code).toBe('NOT_FOUND');

    const wrongHealth = await request(bff.url, '/health', { method: 'POST' });
    expect(wrongHealth.status).toBe(405);
    expect((wrongHealth.json as { code: string }).code).toBe('METHOD_NOT_ALLOWED');

    const wrongSummary = await request(bff.url, summaryPath(), { method: 'POST' });
    expect(wrongSummary.status).toBe(405);
    expect(payments.requests).toHaveLength(0);
    expect(dispatch.requests).toHaveLength(0);
  });

  it('rejects ambiguous request targets before routing', async () => {
    const encoded = await rawRequest(
      bff.url,
      `GET /web/v1/orders/${ORDER_ID}%2Fsummary HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
    );
    expect(encoded.startsWith('HTTP/1.1 400')).toBe(true);

    const absolute = await rawRequest(
      bff.url,
      `GET http://example.com/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
    );
    expect(absolute.startsWith('HTTP/1.1 400')).toBe(true);

    const traversal = await rawRequest(
      bff.url,
      'GET /web/v1/orders/../summary HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n',
    );
    expect(traversal.startsWith('HTTP/1.1 400')).toBe(true);
    expect(payments.requests).toHaveLength(0);
    expect(dispatch.requests).toHaveLength(0);
  });

  it.each([301, 400, 401, 403, 422, 500, 503, 504])(
    'maps an upstream HTTP %i to unavailable and never to timeout',
    async (status) => {
      payments.setHandler((_request, response) => {
        jsonResponse(response, status, { code: 'SOURCE_FAILURE' }, { Location: 'http://evil.example' });
      });
      const response = await request(bff.url, summaryPath());
      expect(response.status).toBe(200);
      expect(response.json).toMatchObject({
        partial: true,
        payment: { availability: 'unavailable' },
        dispatch: { availability: 'available' },
      });
      expect(response.headers.get('location')).toBeNull();
    },
  );

  it.each([301, 400, 401, 403, 422, 500, 503, 504])(
    'maps an upstream dispatch HTTP %i to unavailable',
    async (status) => {
      dispatch.setHandler((_request, response) => {
        jsonResponse(response, status, { code: 'SOURCE_FAILURE' }, { Location: 'http://evil.example' });
      });
      const response = await request(bff.url, summaryPath());
      expect(response.status).toBe(200);
      expect(response.json).toMatchObject({
        partial: true,
        payment: { availability: 'available' },
        dispatch: { availability: 'unavailable' },
      });
      expect(response.headers.get('location')).toBeNull();
    },
  );

  it.each([
    ['invalid JSON', (response: ServerResponse) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{');
    }],
    ['non-JSON', (response: ServerResponse) => textResponse(response, 200, 'not json')],
    ['invalid UTF-8', (response: ServerResponse) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(Buffer.from([0xff, 0xfe]));
    }],
    ['missing content type', (response: ServerResponse) => {
      response.writeHead(200);
      response.end(`{"orderId":"${ORDER_ID}","status":"CHARGED"}`);
    }],
    ['redirect', (response: ServerResponse) => {
      response.writeHead(302, { Location: 'http://evil.example' });
      response.end();
    }],
  ])('maps %s to unavailable', async (_label, handler) => {
    payments.setHandler((_request, response) => handler(response));
    const response = await request(bff.url, summaryPath());
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({
      partial: true,
      payment: { availability: 'unavailable' },
      dispatch: { availability: 'available' },
    });
  });

  it.each([
    ['unknown status', { orderId: ORDER_ID, status: 'SUCCESS' }],
    ['missing status', { orderId: ORDER_ID }],
    ['mismatched orderId', { orderId: OTHER_ORDER_ID, status: 'CHARGED' }],
    ['invalid orderId', { orderId: 'not-a-uuid', status: 'CHARGED' }],
  ])('treats payment payload %s as unavailable', async (_label, payload) => {
    payments.setHandler((_request, response) => jsonResponse(response, 200, payload));
    const response = await request(bff.url, summaryPath());
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({
      partial: true,
      payment: { availability: 'unavailable' },
      dispatch: { availability: 'available' },
    });
  });

  it('maps invalid dispatch JSON to unavailable', async () => {
    dispatch.setHandler((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{');
    });
    const response = await request(bff.url, summaryPath());
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({
      partial: true,
      payment: { availability: 'available' },
      dispatch: { availability: 'unavailable' },
    });
  });

  it.each([
    ['empty items', { orderId: ORDER_ID, status: 'CREATED', items: [] }],
    ['non-array items', { orderId: ORDER_ID, status: 'CREATED', items: {} }],
    ['unknown status', { orderId: ORDER_ID, status: 'SHIPPED', items: [{ partId: PART_ID, quantity: 1 }] }],
    ['invalid partId', { orderId: ORDER_ID, status: 'CREATED', items: [{ partId: 'x', quantity: 1 }] }],
    ['duplicate partId', {
      orderId: ORDER_ID,
      status: 'CREATED',
      items: [{ partId: PART_ID, quantity: 1 }, { partId: PART_ID.toUpperCase(), quantity: 2 }],
    }],
    ['zero quantity', { orderId: ORDER_ID, status: 'CREATED', items: [{ partId: PART_ID, quantity: 0 }] }],
    ['fractional quantity', { orderId: ORDER_ID, status: 'CREATED', items: [{ partId: PART_ID, quantity: 1.5 }] }],
    ['unsafe quantity', { orderId: ORDER_ID, status: 'CREATED', items: [{ partId: PART_ID, quantity: Number.MAX_SAFE_INTEGER + 1 }] }],
    ['mismatched orderId', { orderId: OTHER_ORDER_ID, status: 'CREATED', items: [{ partId: PART_ID, quantity: 1 }] }],
    ['invalid orderId', { orderId: 'not-a-uuid', status: 'CREATED', items: [{ partId: PART_ID, quantity: 1 }] }],
  ])('treats dispatch payload %s as unavailable', async (_label, payload) => {
    dispatch.setHandler((_request, response) => jsonResponse(response, 200, payload));
    const response = await request(bff.url, summaryPath());
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({
      partial: true,
      payment: { availability: 'available' },
      dispatch: { availability: 'unavailable' },
    });
  });

  it('accepts a source body exactly at the configured limit and rejects one byte more', async () => {
    const limit = config.maxResponseBytes;
    const prefix = `{"orderId":"${ORDER_ID}","status":"CHARGED","x":"`;
    const suffix = '"}';
    const exact = `${prefix}${'a'.repeat(limit - prefix.length - suffix.length)}${suffix}`;
    expect(Buffer.byteLength(exact)).toBe(limit);

    payments.setHandler((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(exact);
    });
    const exactResponse = await request(bff.url, summaryPath());
    expect(exactResponse.status).toBe(200);
    expect(exactResponse.json).toMatchObject({
      partial: false,
      payment: { availability: 'available', data: { orderId: ORDER_ID, status: 'CHARGED' } },
    });

    payments.setHandler((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(`${exact} `);
    });
    const oversizedResponse = await request(bff.url, summaryPath());
    expect(oversizedResponse.status).toBe(200);
    expect(oversizedResponse.json).toMatchObject({
      partial: true,
      payment: { availability: 'unavailable' },
      dispatch: { availability: 'available' },
    });
  });

  it('does not forward caller credentials or arbitrary headers to sources', async () => {
    const response = await request(bff.url, summaryPath(), {
      headers: {
        Authorization: 'Bearer client-token',
        Cookie: 'session=secret',
        'X-API-Key': 'client-key',
        'X-Forwarded-For': '203.0.113.10',
      },
    });
    expect(response.status).toBe(200);
    for (const source of [payments.requests[0], dispatch.requests[0]]) {
      expect(source?.headers.authorization).toBeUndefined();
      expect(source?.headers.cookie).toBeUndefined();
      expect(source?.headers['x-api-key']).toBeUndefined();
      expect(source?.headers['x-forwarded-for']).toBeUndefined();
      expect(source?.headers.accept).toBe('application/json');
      expect(isUuid(source?.headers['x-trace-id'])).toBe(true);
    }
  });

  it('generates a new trace when the incoming header is missing', async () => {
    const response = await request(bff.url, summaryPath());
    const trace = response.headers.get('x-trace-id');
    expect(isUuid(trace)).toBe(true);
    expect(payments.requests[0]?.headers['x-trace-id']).toBe(trace);
    expect(dispatch.requests[0]?.headers['x-trace-id']).toBe(trace);
  });

  it('uses a valid unique incoming trace and ignores invalid or duplicate values', async () => {
    const valid = await request(bff.url, summaryPath(), { headers: { 'X-Trace-Id': TRACE_ID } });
    expect(valid.status).toBe(200);
    expect(valid.headers.get('x-trace-id')).toBe(TRACE_ID);
    expect(payments.requests[0]?.headers['x-trace-id']).toBe(TRACE_ID);
    expect(dispatch.requests[0]?.headers['x-trace-id']).toBe(TRACE_ID);

    const invalid = await request(bff.url, summaryPath(), { headers: { 'X-Trace-Id': 'not-a-uuid' } });
    const invalidTrace = invalid.headers.get('x-trace-id');
    expect(invalid.status).toBe(200);
    expect(isUuid(invalidTrace)).toBe(true);
    expect(invalidTrace).not.toBe('not-a-uuid');
    expect(payments.requests[1]?.headers['x-trace-id']).toBe(invalidTrace);
    expect(dispatch.requests[1]?.headers['x-trace-id']).toBe(invalidTrace);

    const raw = await rawRequest(
      bff.url,
      `GET ${summaryPath()} HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Trace-Id: ${TRACE_ID}\r\nX-Trace-Id: ${TRACE_ID}\r\nConnection: close\r\n\r\n`,
    );
    const duplicateTrace = rawHeader(raw, 'x-trace-id');
    expect(raw.startsWith('HTTP/1.1 200')).toBe(true);
    expect(isUuid(duplicateTrace)).toBe(true);
    expect(duplicateTrace).not.toBe(TRACE_ID);
    expect(payments.requests[2]?.headers['x-trace-id']).toBe(duplicateTrace);
    expect(dispatch.requests[2]?.headers['x-trace-id']).toBe(duplicateTrace);
  });

  it('keeps error header and body trace consistent', async () => {
    const response = await request(bff.url, summaryPath('not-a-uuid'), {
      headers: { 'X-Trace-Id': TRACE_ID },
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('x-trace-id')).toBe(TRACE_ID);
    expect((response.json as { traceId: string }).traceId).toBe(TRACE_ID);
  });

  it('generates a new trace for an invalid incoming trace on errors', async () => {
    const response = await request(bff.url, summaryPath('not-a-uuid'), {
      headers: { 'X-Trace-Id': 'not-a-uuid' },
    });
    const trace = response.headers.get('x-trace-id');
    expect(response.status).toBe(400);
    expect(isUuid(trace)).toBe(true);
    expect(trace).not.toBe('not-a-uuid');
    expect((response.json as { traceId: string }).traceId).toBe(trace);
  });

  it('logs only bounded fields and source availability', async () => {
    await request(bff.url, `${summaryPath()}?secret=query-secret`, {
      headers: {
        Authorization: 'Bearer log-secret',
        Cookie: 'cookie-secret',
      },
    });
    const logs = JSON.stringify(logger.records);
    expect(logs).not.toContain(ORDER_ID);
    expect(logs).not.toContain('query-secret');
    expect(logs).not.toContain('log-secret');
    expect(logs).not.toContain('cookie-secret');
    expect(logger.records.at(-1)).toMatchObject({
      route: '/web/v1/orders/:orderId/summary',
      status: 200,
      payment: 'available',
      dispatch: 'available',
    });
    expect(isUuid(logger.records.at(-1)?.traceId)).toBe(true);
  });

  it('keeps health alive when both sources are down', async () => {
    await restart({
      paymentsBaseUrl: 'http://127.0.0.1:1',
      dispatchBaseUrl: 'http://127.0.0.1:2',
    });
    const health = await request(bff.url, '/health');
    expect(health.status).toBe(200);
    const summary = await request(bff.url, summaryPath());
    expect(summary.status).toBe(503);
    expect((summary.json as { code: string }).code).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('marks a single unreachable source as unavailable while keeping the other available', async () => {
    await restart({ paymentsBaseUrl: 'http://127.0.0.1:1' });
    const response = await request(bff.url, summaryPath());
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({
      partial: true,
      payment: { availability: 'unavailable' },
      dispatch: { availability: 'available' },
    });
  });
});
