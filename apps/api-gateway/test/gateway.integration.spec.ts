import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import { SignJWT } from 'jose';
import type { GatewayConfig } from '../src/config/gateway-config.js';
import { isUuid } from '../src/http/uuid.js';
import {
  bearer,
  jsonHeaders,
  jsonResponse,
  MemoryLogger,
  rawRequest,
  request,
  startGateway,
  startStubServer,
  testConfig,
  textResponse,
  tokenFor,
  type GatewayHandle,
  type StubRequest,
  type StubServer,
} from './helpers.js';

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const ORDER_ID = '22222222-2222-4222-8222-222222222222';
const PART_ID = '33333333-3333-4333-8333-333333333333';
const SALES_TRACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BFF_TRACE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function pathOf(url: string): string {
  return url.split('?', 1)[0] ?? url;
}

function defaultSalesHandler(stubRequest: StubRequest, response: ServerResponse): void {
  const path = pathOf(stubRequest.url);
  const trace = { 'X-Trace-Id': SALES_TRACE };
  if (path === '/v1/health' && stubRequest.method === 'GET') {
    jsonResponse(response, 200, { status: 'ok', service: 'sales-api' }, trace);
    return;
  }
  if (path === '/v1/customers' && stubRequest.method === 'POST') {
    jsonResponse(
      response,
      201,
      { id: CUSTOMER_ID, name: 'Demo', email: 'demo@example.com', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      { ...trace, Location: `/v1/customers/${CUSTOMER_ID}` },
    );
    return;
  }
  if (path === '/v1/customers' && stubRequest.method === 'GET') {
    jsonResponse(response, 200, { page: 1, pageSize: 20, total: 0, items: [] }, trace);
    return;
  }
  if (path === `/v1/customers/${CUSTOMER_ID}` && stubRequest.method === 'GET') {
    jsonResponse(response, 200, { id: CUSTOMER_ID, name: 'Demo', email: 'demo@example.com', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }, trace);
    return;
  }
  if (path === '/v1/orders' && stubRequest.method === 'POST') {
    jsonResponse(
      response,
      201,
      { id: ORDER_ID, customerId: CUSTOMER_ID, status: 'CONFIRMED', items: [{ partId: PART_ID, sku: 'SKU-1', name: 'Part', quantity: 1 }], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      { ...trace, Location: `/v1/orders/${ORDER_ID}`, 'Idempotency-Replayed': 'false' },
    );
    return;
  }
  if (path === '/v1/orders' && stubRequest.method === 'GET') {
    jsonResponse(response, 200, { page: 1, pageSize: 20, total: 0, items: [] }, trace);
    return;
  }
  if (path === `/v1/orders/${ORDER_ID}` && stubRequest.method === 'GET') {
    jsonResponse(response, 200, { id: ORDER_ID, customerId: CUSTOMER_ID, status: 'CONFIRMED', items: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }, trace);
    return;
  }
  if (path === `/v1/orders/${ORDER_ID}/cancel` && stubRequest.method === 'POST') {
    jsonResponse(response, 200, { id: ORDER_ID, customerId: CUSTOMER_ID, status: 'CANCELLED', items: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', cancelledAt: '2026-01-01T00:00:00.000Z' }, trace);
    return;
  }
  jsonResponse(response, 404, { code: 'ORDER_NOT_FOUND', message: 'Order not found', traceId: SALES_TRACE }, trace);
}

function defaultBffHandler(stubRequest: StubRequest, response: ServerResponse): void {
  if (pathOf(stubRequest.url) === `/web/v1/orders/${ORDER_ID}/summary` && stubRequest.method === 'GET') {
    jsonResponse(
      response,
      200,
      {
        orderId: ORDER_ID,
        partial: false,
        payment: { availability: 'available', data: { orderId: ORDER_ID, status: 'CHARGED' } },
        dispatch: { availability: 'available', data: { orderId: ORDER_ID, status: 'CREATED', items: [{ partId: PART_ID, quantity: 1 }] } },
      },
      { 'X-Trace-Id': BFF_TRACE },
    );
    return;
  }
  jsonResponse(response, 404, { code: 'SUMMARY_NOT_FOUND', message: 'Summary not found', traceId: BFF_TRACE }, { 'X-Trace-Id': BFF_TRACE });
}

describe('API Gateway integration', () => {
  let sales: StubServer;
  let bff: StubServer;
  let config: GatewayConfig;
  let gateway: GatewayHandle;
  let logger: MemoryLogger;

  async function restart(overrides: Partial<GatewayConfig> = {}): Promise<void> {
    await gateway.close();
    config = { ...config, ...overrides };
    gateway = await startGateway(config, { logger });
  }

  beforeEach(async () => {
    sales = await startStubServer(defaultSalesHandler);
    bff = await startStubServer(defaultBffHandler);
    config = testConfig(sales.url, bff.url);
    logger = new MemoryLogger();
    gateway = await startGateway(config, { logger });
  });

  afterEach(async () => {
    await gateway.close();
    await sales.close();
    await bff.close();
  });

  it('serves its own liveness without consulting upstreams', async () => {
    const response = await request(gateway.url, '/health');
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ status: 'ok', service: 'gateway' });
    expect(isUuid(response.headers.get('x-trace-id'))).toBe(true);
    expect(sales.requests).toHaveLength(0);
    expect(bff.requests).toHaveLength(0);
  });

  it('proxies public Sales health without credentials and preserves its trace', async () => {
    const response = await request(gateway.url, '/v1/health');
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ status: 'ok', service: 'sales-api' });
    expect(response.headers.get('x-trace-id')).toBe(SALES_TRACE);
    expect(sales.requests).toHaveLength(1);
    expect(sales.requests[0]?.headers.authorization).toBeUndefined();
    expect(sales.requests[0]?.headers['x-api-key']).toBeUndefined();
  });

  it('returns 401 for missing or external-only credentials', async () => {
    for (const headers of [undefined, { 'X-API-Key': 'reader-internal-key' }]) {
      const response = await request(gateway.url, '/v1/customers', headers === undefined ? {} : { headers });
      expect(response.status).toBe(401);
      expect((response.json as { code: string }).code).toBe('UNAUTHORIZED');
      expect(response.headers.get('www-authenticate')).toContain('Bearer');
      expect((response.json as { traceId: string }).traceId).toBe(response.headers.get('x-trace-id'));
    }
    expect(sales.requests).toHaveLength(0);
  });

  it('uses the JWT role to inject the matching internal key and strips caller credentials', async () => {
    const token = await tokenFor(config, 'reader-1', 'reader');
    const response = await request(gateway.url, '/v1/customers?page=1&pageSize=2', {
      headers: {
        ...bearer(token),
        'X-API-Key': 'external-key-must-not-authenticate',
        Cookie: 'session=must-not-forward',
        'X-Forwarded-For': '203.0.113.10',
        'X-Trace-Id': 'client-controlled-trace',
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('x-trace-id')).toBe(SALES_TRACE);
    expect(sales.requests).toHaveLength(1);
    const upstream = sales.requests[0];
    expect(upstream?.url).toBe('/v1/customers?page=1&pageSize=2');
    expect(upstream?.headers['x-api-key']).toBe(config.salesApiKeyReader);
    expect(upstream?.headers.authorization).toBeUndefined();
    expect(upstream?.headers.cookie).toBeUndefined();
    expect(upstream?.headers['x-forwarded-for']).toBeUndefined();
    expect(upstream?.headers['x-trace-id']).toBeUndefined();
  });

  it('requires JWT for order routes while keeping health public', async () => {
    const orders = await request(gateway.url, '/v1/orders');
    expect(orders.status).toBe(401);
    expect((orders.json as { code: string }).code).toBe('UNAUTHORIZED');

    const create = await request(gateway.url, '/v1/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(create.status).toBe(401);

    const health = await request(gateway.url, '/v1/health');
    expect(health.status).toBe(200);
    expect(sales.requests).toHaveLength(1);
  });

  it('allows reader GET but rejects reader POST with 403', async () => {
    const token = await tokenFor(config, 'reader-1', 'reader');
    const allowed = await request(gateway.url, '/v1/customers', { headers: bearer(token) });
    expect(allowed.status).toBe(200);

    const denied = await request(gateway.url, '/v1/customers', {
      method: 'POST',
      headers: jsonHeaders(token),
      body: '{}',
    });
    expect(denied.status).toBe(403);
    expect((denied.json as { code: string }).code).toBe('FORBIDDEN');
    expect(sales.requests).toHaveLength(1);
  });

  it('does not let an external operator key elevate a reader JWT', async () => {
    const reader = await tokenFor(config, 'reader-1', 'reader');
    const response = await request(gateway.url, '/v1/customers', {
      method: 'POST',
      headers: { ...jsonHeaders(reader), 'X-API-Key': config.salesApiKeyOperator },
      body: '{}',
    });
    expect(response.status).toBe(403);
    expect((response.json as { code: string }).code).toBe('FORBIDDEN');
    expect(sales.requests).toHaveLength(0);
  });

  it('allows operator POST and rejects an invalid signature', async () => {
    const operator = await tokenFor(config, 'operator-1', 'operator');
    const created = await request(gateway.url, '/v1/customers', {
      method: 'POST',
      headers: jsonHeaders(operator),
      body: '{}',
    });
    expect(created.status).toBe(201);

    const invalid = await tokenFor({ ...config, secret: 'z'.repeat(32) }, 'reader-1', 'reader');
    const rejected = await request(gateway.url, '/v1/customers', { headers: bearer(invalid) });
    expect(rejected.status).toBe(401);
    expect(sales.requests).toHaveLength(1);
  });

  it('rejects duplicate Authorization headers using rawHeaders', async () => {
    const token = await tokenFor(config, 'duplicate-1', 'reader');
    const raw = await rawRequest(
      gateway.url,
      `GET /v1/customers HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${token}\r\nAuthorization: Bearer ${token}\r\nConnection: close\r\n\r\n`,
    );
    expect(raw.startsWith('HTTP/1.1 401')).toBe(true);
    expect(sales.requests).toHaveLength(0);
  });

  it('rejects a signed token with padded subject without normalizing it', async () => {
    const token = await new SignJWT({ role: 'reader' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(config.issuer)
      .setAudience(config.audience)
      .setSubject(' padded-sub ')
      .setExpirationTime(Math.floor(Date.now() / 1_000) + 900)
      .sign(new TextEncoder().encode(config.secret));
    const response = await request(gateway.url, '/v1/customers', { headers: bearer(token) });
    expect(response.status).toBe(401);
    expect(sales.requests).toHaveLength(0);
  });

  it('does not authenticate tokens supplied in query or cookie', async () => {
    const token = await tokenFor(config, 'reader-1', 'reader');
    const response = await request(gateway.url, `/v1/customers?access_token=${token}`, {
      headers: { Cookie: `token=${token}` },
    });
    expect(response.status).toBe(401);
    expect(sales.requests).toHaveLength(0);
  });

  it('routes every documented operation to its target', async () => {
    const reader = await tokenFor(config, 'reader-1', 'reader');
    const operator = await tokenFor(config, 'operator-1', 'operator');
    const cases: Array<{
      method: string;
      path: string;
      headers: Record<string, string>;
      body?: string;
      target: 'sales' | 'bff' | 'local';
      expectedStatus: number;
    }> = [
      { method: 'GET', path: '/health', headers: {}, target: 'local', expectedStatus: 200 },
      { method: 'GET', path: '/v1/health', headers: {}, target: 'sales', expectedStatus: 200 },
      { method: 'POST', path: '/v1/customers', headers: jsonHeaders(operator), body: '{}', target: 'sales', expectedStatus: 201 },
      { method: 'GET', path: '/v1/customers', headers: bearer(reader), target: 'sales', expectedStatus: 200 },
      { method: 'GET', path: `/v1/customers/${CUSTOMER_ID}`, headers: bearer(reader), target: 'sales', expectedStatus: 200 },
      { method: 'POST', path: '/v1/orders', headers: { ...jsonHeaders(operator), 'Idempotency-Key': 'idem-key-1' }, body: '{}', target: 'sales', expectedStatus: 201 },
      { method: 'GET', path: '/v1/orders', headers: bearer(reader), target: 'sales', expectedStatus: 200 },
      { method: 'GET', path: `/v1/orders/${ORDER_ID}`, headers: bearer(reader), target: 'sales', expectedStatus: 200 },
      { method: 'POST', path: `/v1/orders/${ORDER_ID}/cancel`, headers: bearer(operator), target: 'sales', expectedStatus: 200 },
      { method: 'GET', path: `/web/v1/orders/${ORDER_ID}/summary`, headers: bearer(reader), target: 'bff', expectedStatus: 200 },
    ];

    for (const testCase of cases) {
      const response = await request(gateway.url, testCase.path, {
        method: testCase.method,
        headers: testCase.headers,
        ...(testCase.body !== undefined ? { body: testCase.body } : {}),
      });
      expect(response.status).toBe(testCase.expectedStatus);
    }

    expect(sales.requests).toHaveLength(8);
    expect(bff.requests).toHaveLength(1);
    expect(sales.requests.map((entry) => entry.url)).toEqual([
      '/v1/health',
      '/v1/customers',
      '/v1/customers',
      `/v1/customers/${CUSTOMER_ID}`,
      '/v1/orders',
      '/v1/orders',
      `/v1/orders/${ORDER_ID}`,
      `/v1/orders/${ORDER_ID}/cancel`,
    ]);
  });

  it('denies unknown paths, wrong methods and internal routes without proxying', async () => {
    const reader = await tokenFor(config, 'reader-1', 'reader');
    const unknown = await request(gateway.url, '/v1/not-a-route', { headers: bearer(reader) });
    expect(unknown.status).toBe(404);
    expect((unknown.json as { code: string }).code).toBe('NOT_FOUND');

    const wrongMethod = await request(gateway.url, '/v1/health', { method: 'POST', headers: bearer(reader) });
    expect(wrongMethod.status).toBe(405);
    expect((wrongMethod.json as { code: string }).code).toBe('METHOD_NOT_ALLOWED');

    const internal = await request(gateway.url, '/internal/v1/dispatches/x', { headers: bearer(reader) });
    expect(internal.status).toBe(404);

    const unauthenticatedInternal = await request(gateway.url, '/internal/v1/dispatches/x');
    expect(unauthenticatedInternal.status).toBe(401);
    expect(sales.requests).toHaveLength(0);
    expect(bff.requests).toHaveLength(0);
  });

  it('rejects ambiguous request targets before proxying', async () => {
    const reader = await tokenFor(config, 'reader-1', 'reader');
    const encodedSlash = await rawRequest(
      gateway.url,
      `GET /v1/customers%2F1 HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${reader}\r\nConnection: close\r\n\r\n`,
    );
    expect(encodedSlash.startsWith('HTTP/1.1 400')).toBe(true);

    const absoluteForm = await rawRequest(
      gateway.url,
      `GET http://example.com/v1/orders HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${reader}\r\nConnection: close\r\n\r\n`,
    );
    expect(absoluteForm.startsWith('HTTP/1.1 400')).toBe(true);
    expect(sales.requests).toHaveLength(0);
  });

  it('combines repeated Accept headers in order before forwarding', async () => {
    const reader = await tokenFor(config, 'reader-1', 'reader');
    const raw = await rawRequest(
      gateway.url,
      `GET /v1/customers HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${reader}\r\nAccept: application/json\r\nAccept: application/vnd.repuestossur+json\r\nConnection: close\r\n\r\n`,
    );
    expect(raw.startsWith('HTTP/1.1 200')).toBe(true);
    expect(sales.requests).toHaveLength(1);
    expect(sales.requests[0]?.headers.accept).toBe('application/json, application/vnd.repuestossur+json');
  });

  it('preserves method, query, raw body, idempotency key, status and response headers', async () => {
    sales.setHandler((stubRequest, response) => {
      jsonResponse(
        response,
        201,
        { id: ORDER_ID, status: 'CONFIRMED' },
        { 'X-Trace-Id': SALES_TRACE, Location: `/v1/orders/${ORDER_ID}`, 'Idempotency-Replayed': 'true' },
      );
    });
    const operator = await tokenFor(config, 'operator-1', 'operator');
    const rawBody = `{ "customerId" : "${CUSTOMER_ID}", "items" : [ { "partId" : "${PART_ID}", "quantity" : 1 } ] }`;
    const response = await request(gateway.url, '/v1/orders?page=1&status=CONFIRMED&status=CANCELLED', {
      method: 'POST',
      headers: {
        ...jsonHeaders(operator),
        'Idempotency-Key': 'idem-key-123',
        'X-API-Key': 'external-key',
        Cookie: 'secret=cookie',
        'X-Forwarded-For': '203.0.113.10',
        'X-Trace-Id': 'client-trace',
      },
      body: rawBody,
    });

    expect(response.status).toBe(201);
    expect(response.headers.get('location')).toBe(`/v1/orders/${ORDER_ID}`);
    expect(response.headers.get('idempotency-replayed')).toBe('true');
    expect(response.headers.get('x-trace-id')).toBe(SALES_TRACE);
    expect(response.json).toEqual({ id: ORDER_ID, status: 'CONFIRMED' });

    expect(sales.requests).toHaveLength(1);
    const upstream = sales.requests[0];
    expect(upstream?.method).toBe('POST');
    expect(upstream?.url).toBe('/v1/orders?page=1&status=CONFIRMED&status=CANCELLED');
    expect(upstream?.body.toString('utf8')).toBe(rawBody);
    expect(upstream?.headers['idempotency-key']).toBe('idem-key-123');
    expect(upstream?.headers['x-api-key']).toBe(config.salesApiKeyOperator);
    expect(upstream?.headers.authorization).toBeUndefined();
    expect(upstream?.headers.cookie).toBeUndefined();
    expect(upstream?.headers['x-forwarded-for']).toBeUndefined();
    expect(upstream?.headers['x-trace-id']).toBeUndefined();
  });

  it.each([
    [409, 'INSUFFICIENT_STOCK'],
    [503, 'INVENTORY_UNAVAILABLE'],
    [504, 'INVENTORY_TIMEOUT'],
  ])('preserves Sales error status %i and body', async (status, code) => {
    sales.setHandler((_stubRequest, response) => {
      jsonResponse(
        response,
        status,
        { code, message: 'Sales error', traceId: SALES_TRACE },
        { 'X-Trace-Id': SALES_TRACE },
      );
    });
    const reader = await tokenFor(config, 'reader-1', 'reader');
    const response = await request(gateway.url, '/v1/customers', { headers: bearer(reader) });
    expect(response.status).toBe(status);
    expect(response.json).toEqual({ code, message: 'Sales error', traceId: SALES_TRACE });
    expect(response.headers.get('x-trace-id')).toBe(SALES_TRACE);
    expect(sales.requests).toHaveLength(1);
  });

  it.each([401, 403])('turns an internal Sales %i into a local 503', async (status) => {
    sales.setHandler((_stubRequest, response) => {
      jsonResponse(
        response,
        status,
        { code: 'UNAUTHORIZED', message: 'Missing or invalid API key', traceId: SALES_TRACE },
        { 'X-Trace-Id': SALES_TRACE, 'WWW-Authenticate': 'ApiKey realm="repuestossur"' },
      );
    });
    const reader = await tokenFor(config, 'reader-1', 'reader');
    const response = await request(gateway.url, '/v1/customers', { headers: bearer(reader) });
    expect(response.status).toBe(503);
    expect((response.json as { code: string }).code).toBe('UPSTREAM_UNAVAILABLE');
    expect(response.headers.get('www-authenticate')).toBeNull();
    expect((response.json as { traceId: string }).traceId).toBe(response.headers.get('x-trace-id'));
  });

  it.each([
    ['redirect', (response: ServerResponse) => {
      response.writeHead(302, { Location: 'http://evil.example' });
      response.end();
    }],
    ['non-JSON', (response: ServerResponse) => textResponse(response, 200, 'not json')],
    ['invalid JSON', (response: ServerResponse) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{');
    }],
    ['oversized', (response: ServerResponse) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(`{"x":"${'a'.repeat(2_097_152)}"}`);
    }],
  ])('maps an upstream %s response to 503', async (_label, handler) => {
    sales.setHandler((_stubRequest, response) => handler(response));
    const reader = await tokenFor(config, 'reader-1', 'reader');
    const response = await request(gateway.url, '/v1/customers', { headers: bearer(reader) });
    expect(response.status).toBe(503);
    expect((response.json as { code: string }).code).toBe('UPSTREAM_UNAVAILABLE');
    expect(response.headers.get('location')).toBeNull();
    expect(sales.requests).toHaveLength(1);
  });

  it('times out a slow response body and does not retry', async () => {
    await restart({ salesTimeoutMs: 50 });
    sales.setHandler((_stubRequest, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json', 'X-Trace-Id': SALES_TRACE });
      response.write('{"status":');
      setTimeout(() => response.end('"ok"}'), 250);
    });
    const reader = await tokenFor(config, 'reader-1', 'reader');
    const response = await request(gateway.url, '/v1/customers', { headers: bearer(reader) });
    expect(response.status).toBe(504);
    expect((response.json as { code: string }).code).toBe('UPSTREAM_TIMEOUT');
    expect(sales.requests).toHaveLength(1);
  });

  it('times out when the upstream never sends headers', async () => {
    await restart({ salesTimeoutMs: 50 });
    sales.setHandler((_stubRequest, response) => {
      setTimeout(() => {
        if (!response.headersSent) response.end('{"late":true}');
      }, 250);
    });
    const reader = await tokenFor(config, 'reader-1', 'reader');
    const response = await request(gateway.url, '/v1/customers', { headers: bearer(reader) });
    expect(response.status).toBe(504);
    expect((response.json as { code: string }).code).toBe('UPSTREAM_TIMEOUT');
    expect(sales.requests).toHaveLength(1);
  });

  it('does not forward a compressed upstream content-encoding after fetch decompresses', async () => {
    sales.setHandler((_stubRequest, response) => {
      const compressed = gzipSync(JSON.stringify({ page: 1, pageSize: 20, total: 0, items: [] }));
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Encoding': 'gzip',
        'X-Trace-Id': SALES_TRACE,
      });
      response.end(compressed);
    });
    const reader = await tokenFor(config, 'reader-1', 'reader');
    const response = await request(gateway.url, '/v1/customers', { headers: bearer(reader) });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.json).toEqual({ page: 1, pageSize: 20, total: 0, items: [] });
  });

  it('keeps liveness independent when Sales is down and reports a local 503 for Sales health', async () => {
    await restart({ salesBaseUrl: 'http://127.0.0.1:1' });
    const health = await request(gateway.url, '/health');
    expect(health.status).toBe(200);
    const salesHealth = await request(gateway.url, '/v1/health');
    expect(salesHealth.status).toBe(503);
    expect((salesHealth.json as { code: string }).code).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('rejects malformed JSON, wrong media types, GET bodies and oversized bodies', async () => {
    const operator = await tokenFor(config, 'operator-1', 'operator');
    const malformed = await request(gateway.url, '/v1/customers', {
      method: 'POST',
      headers: jsonHeaders(operator),
      body: '{',
    });
    expect(malformed.status).toBe(400);

    const wrongType = await request(gateway.url, '/v1/customers', {
      method: 'POST',
      headers: { ...bearer(operator), 'Content-Type': 'text/plain' },
      body: '{}',
    });
    expect(wrongType.status).toBe(400);

    const getBody = await rawRequest(
      gateway.url,
      `GET /v1/customers HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${operator}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`,
    );
    expect(getBody.startsWith('HTTP/1.1 400')).toBe(true);

    const oversized = await request(gateway.url, '/v1/customers', {
      method: 'POST',
      headers: jsonHeaders(operator),
      body: 'x'.repeat(1_048_577),
    });
    expect(oversized.status).toBe(413);
    expect((oversized.json as { code: string }).code).toBe('PAYLOAD_TOO_LARGE');
    expect(sales.requests).toHaveLength(0);
  });

  it('rejects duplicate Idempotency-Key and missing Content-Type before upstream', async () => {
    const operator = await tokenFor(config, 'operator-1', 'operator');
    const duplicateKey = await rawRequest(
      gateway.url,
      `POST /v1/orders HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${operator}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nIdempotency-Key: key-one\r\nIdempotency-Key: key-two\r\nConnection: close\r\n\r\n{}`,
    );
    expect(duplicateKey.startsWith('HTTP/1.1 400')).toBe(true);

    const missingType = await rawRequest(
      gateway.url,
      `POST /v1/customers HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${operator}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`,
    );
    expect(missingType.startsWith('HTTP/1.1 400')).toBe(true);
    expect(sales.requests).toHaveLength(0);
  });

  it('accepts a JSON body exactly at the 1 MiB boundary', async () => {
    const operator = await tokenFor(config, 'operator-1', 'operator');
    const prefix = '{"x":"';
    const suffix = '"}';
    const body = `${prefix}${'a'.repeat(1_048_576 - prefix.length - suffix.length)}${suffix}`;
    expect(Buffer.byteLength(body)).toBe(1_048_576);
    const response = await request(gateway.url, '/v1/customers', {
      method: 'POST',
      headers: jsonHeaders(operator),
      body,
    });
    expect(response.status).toBe(201);
    expect(sales.requests[0]?.body.length).toBe(1_048_576);
  });

  it('preserves Sales traces and logs only safe correlation fields', async () => {
    sales.setHandler((_stubRequest, response) => {
      jsonResponse(
        response,
        409,
        { code: 'INSUFFICIENT_STOCK', message: 'No stock', traceId: SALES_TRACE },
        { 'X-Trace-Id': SALES_TRACE },
      );
    });
    const token = await tokenFor(config, 'operator-1', 'operator');
    const response = await request(gateway.url, '/v1/customers?secret=query-secret', {
      method: 'POST',
      headers: {
        ...jsonHeaders(token),
        'X-API-Key': 'external-secret-key',
        Cookie: 'cookie-secret',
      },
      body: '{"secret":"body-secret"}',
    });
    expect(response.status).toBe(409);
    expect((response.json as { traceId: string }).traceId).toBe(SALES_TRACE);

    const record = logger.records.at(-1);
    expect(record?.upstreamTraceId).toBe(SALES_TRACE);
    expect(isUuid(record?.gatewayRequestId)).toBe(true);
    expect(record?.gatewayRequestId).not.toBe(SALES_TRACE);
    const logs = JSON.stringify(logger.records);
    expect(logs).not.toContain(token);
    expect(logs).not.toContain('external-secret-key');
    expect(logs).not.toContain('cookie-secret');
    expect(logs).not.toContain('query-secret');
    expect(logs).not.toContain('body-secret');
  });

  it('uses the gateway request id for its own errors and for the BFF summary trace', async () => {
    const reader = await tokenFor(config, 'reader-1', 'reader');
    const localError = await request(gateway.url, '/v1/customers');
    expect(localError.status).toBe(401);
    const localRecord = logger.records.at(-1);
    expect(localRecord?.gatewayRequestId).toBe(localError.headers.get('x-trace-id'));
    expect((localError.json as { traceId: string }).traceId).toBe(localRecord?.gatewayRequestId);

    const summary = await request(gateway.url, `/web/v1/orders/${ORDER_ID}/summary`, {
      headers: bearer(reader),
    });
    expect(summary.status).toBe(200);
    expect(summary.headers.get('x-trace-id')).toBe(BFF_TRACE);
    expect(bff.requests).toHaveLength(1);
    const forwardedTrace = bff.requests[0]?.headers['x-trace-id'];
    expect(isUuid(forwardedTrace)).toBe(true);
    const summaryRecord = logger.records.at(-1);
    expect(summaryRecord?.gatewayRequestId).toBe(forwardedTrace);
    expect(summaryRecord?.upstreamTraceId).toBe(BFF_TRACE);
  });
});
