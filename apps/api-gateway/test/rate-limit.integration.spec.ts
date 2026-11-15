import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GatewayConfig } from '../src/config/gateway-config.js';
import { isUuid } from '../src/http/uuid.js';
import {
  bearer,
  jsonHeaders,
  jsonResponse,
  MemoryLogger,
  request,
  startGateway,
  startStubServer,
  testConfig,
  tokenFor,
  type GatewayHandle,
  type StubServer,
} from './helpers.js';

describe('API Gateway rate limit', () => {
  let sales: StubServer;
  let bff: StubServer;
  let config: GatewayConfig;
  let gateway: GatewayHandle;
  let logger: MemoryLogger;
  let now: number;

  async function restart(overrides: Partial<GatewayConfig> = {}): Promise<void> {
    await gateway.close();
    config = { ...config, ...overrides };
    gateway = await startGateway(config, { clock: () => now, logger });
  }

  beforeEach(async () => {
    now = 1_800_000_000_000;
    sales = await startStubServer((_request, response) => {
      jsonResponse(response, 200, { page: 1, pageSize: 20, total: 0, items: [] }, {
        'X-Trace-Id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      });
    });
    bff = await startStubServer((_request, response) => {
      jsonResponse(response, 404, { code: 'SUMMARY_NOT_FOUND', message: 'Not found', traceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
    });
    config = testConfig(sales.url, bff.url, {
      rateLimitMaxRequests: 2,
      rateLimitMaxIdentities: 2,
      rateLimitWindowMs: 60_000,
    });
    logger = new MemoryLogger();
    gateway = await startGateway(config, { clock: () => now, logger });
  });

  afterEach(async () => {
    await gateway.close();
    await sales.close();
    await bff.close();
  });

  it('allows two requests and rejects the third with Retry-After and a consistent trace', async () => {
    const token = await tokenFor(config, 'reader-1', 'reader', { nowSeconds: now / 1_000 });
    for (let index = 0; index < 2; index += 1) {
      const response = await request(gateway.url, '/v1/customers', { headers: bearer(token) });
      expect(response.status).toBe(200);
    }

    const limited = await request(gateway.url, '/v1/customers', {
      headers: { ...bearer(token), 'X-Forwarded-For': '203.0.113.99' },
    });
    expect(limited.status).toBe(429);
    expect((limited.json as { code: string }).code).toBe('RATE_LIMIT_EXCEEDED');
    expect(limited.headers.get('retry-after')).toBe('60');
    expect((limited.json as { traceId: string }).traceId).toBe(limited.headers.get('x-trace-id'));
    expect(isUuid(limited.headers.get('x-trace-id'))).toBe(true);
    expect(sales.requests).toHaveLength(2);
  });

  it('shares quota across two different JWTs with the same subject', async () => {
    const first = await tokenFor(config, 'shared-sub', 'reader', { nowSeconds: now / 1_000 });
    const second = await tokenFor(config, 'shared-sub', 'reader', { nowSeconds: now / 1_000 + 1 });
    expect(first).not.toBe(second);

    expect((await request(gateway.url, '/v1/customers', { headers: bearer(first) })).status).toBe(200);
    expect((await request(gateway.url, '/v1/customers', { headers: bearer(second) })).status).toBe(200);
    expect((await request(gateway.url, '/v1/customers', { headers: bearer(first) })).status).toBe(429);
  });

  it('keeps quotas independent for different subjects', async () => {
    const first = await tokenFor(config, 'subject-a', 'reader', { nowSeconds: now / 1_000 });
    const second = await tokenFor(config, 'subject-b', 'reader', { nowSeconds: now / 1_000 });
    for (let index = 0; index < 2; index += 1) {
      expect((await request(gateway.url, '/v1/customers', { headers: bearer(first) })).status).toBe(200);
      expect((await request(gateway.url, '/v1/customers', { headers: bearer(second) })).status).toBe(200);
    }
  });

  it('does not limit health and does not count 401/403/404/405 toward quota', async () => {
    const reader = await tokenFor(config, 'reader-1', 'reader', { nowSeconds: now / 1_000 });
    for (let index = 0; index < 4; index += 1) {
      expect((await request(gateway.url, '/health')).status).toBe(200);
      expect((await request(gateway.url, '/v1/health')).status).toBe(200);
    }

    expect((await request(gateway.url, '/v1/customers')).status).toBe(401);
    expect((await request(gateway.url, '/v1/customers', {
      method: 'POST',
      headers: jsonHeaders(reader),
      body: '{}',
    })).status).toBe(403);
    expect((await request(gateway.url, '/v1/unknown', { headers: bearer(reader) })).status).toBe(404);
    expect((await request(gateway.url, '/v1/health', {
      method: 'POST',
      headers: bearer(reader),
    })).status).toBe(405);

    expect((await request(gateway.url, '/v1/customers', { headers: bearer(reader) })).status).toBe(200);
    expect((await request(gateway.url, '/v1/customers', { headers: bearer(reader) })).status).toBe(200);
    expect((await request(gateway.url, '/v1/customers', { headers: bearer(reader) })).status).toBe(429);
  });

  it('does not evict an active identity when the cap is reached and recovers after the window', async () => {
    const first = await tokenFor(config, 'subject-a', 'reader', { nowSeconds: now / 1_000 });
    const second = await tokenFor(config, 'subject-b', 'reader', { nowSeconds: now / 1_000 });
    const third = await tokenFor(config, 'subject-c', 'reader', { nowSeconds: now / 1_000 });

    expect((await request(gateway.url, '/v1/customers', { headers: bearer(first) })).status).toBe(200);
    expect((await request(gateway.url, '/v1/customers', { headers: bearer(second) })).status).toBe(200);
    expect((await request(gateway.url, '/v1/customers', { headers: bearer(third) })).status).toBe(429);
    expect((await request(gateway.url, '/v1/customers', { headers: bearer(first) })).status).toBe(200);

    now += 60_000;
    expect((await request(gateway.url, '/v1/customers', { headers: bearer(third) })).status).toBe(200);
  });

  it('reports the actual remaining time in Retry-After', async () => {
    await restart({ rateLimitMaxRequests: 1 });
    now += 15_000;
    const token = await tokenFor(config, 'reader-1', 'reader', { nowSeconds: now / 1_000 });
    expect((await request(gateway.url, '/v1/customers', { headers: bearer(token) })).status).toBe(200);
    const limited = await request(gateway.url, '/v1/customers', { headers: bearer(token) });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('45');

    now += 15_000;
    const later = await request(gateway.url, '/v1/customers', { headers: bearer(token) });
    expect(later.status).toBe(429);
    expect(later.headers.get('retry-after')).toBe('30');
  });

  it('allows exactly the configured limit under concurrent requests', async () => {
    await restart({ rateLimitMaxRequests: 60, rateLimitMaxIdentities: 10 });
    const token = await tokenFor(config, 'concurrent-sub', 'reader', { nowSeconds: now / 1_000 });
    const responses = await Promise.all(
      Array.from({ length: 100 }, async () => request(gateway.url, '/v1/customers', { headers: bearer(token) })),
    );
    expect(responses.filter((response) => response.status === 200)).toHaveLength(60);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(40);
    expect(sales.requests).toHaveLength(60);
  });
});
