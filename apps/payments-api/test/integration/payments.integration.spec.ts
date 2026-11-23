import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { INestApplication } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type { PaymentsConfig } from '../../src/config.js';
import { PaymentsDatabase } from '../../src/database.js';
import { PaymentsReconciler } from '../../src/payments.reconciler.js';
import { GatewaySim } from '../gateway-sim.js';
import { testConfig } from '../test-config.js';

// T2-201/T2-202: Pagos con PostgreSQL real y la pasarela simulada real.
// La pasarela cuenta sus efectos (cobros aprobados, reembolsos, anulaciones):
// así se verifica que ningún reintento cobra o reembolsa dos veces.

function testDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL;
  if (!value) throw new Error('TEST_DATABASE_URL must point to a disposable Payments test database');
  const databaseName = new URL(value).pathname.slice(1);
  if (!databaseName.toLowerCase().includes('test')) {
    throw new Error(`TEST_DATABASE_URL database name must contain "test", got "${databaseName}"`);
  }
  return value;
}

const sim = new GatewaySim();
let app: INestApplication | undefined;
let baseUrl = '';

interface Reply {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
  ms: number;
}

async function startApp(overrides: Partial<PaymentsConfig> = {}): Promise<void> {
  app = await createApp(testConfig(testDatabaseUrl(), sim.baseUrl, overrides), false);
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  await app.get(PaymentsDatabase).$executeRawUnsafe('TRUNCATE TABLE "payments"');
}

async function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const startedAt = performance.now();
  const init: RequestInit = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json', ...headers };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl.replace('[::1]', '127.0.0.1')}${path}`, init);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers, ms: performance.now() - startedAt };
}

const charge = (orderId: string, amountMinor = 20_000, currency = 'CLP') =>
  request('PUT', `/internal/v1/payments/${orderId}`, { amountMinor, currency });
const get = (orderId: string) => request('GET', `/internal/v1/payments/${orderId}`);
const refund = (orderId: string) => request('POST', `/internal/v1/payments/${orderId}/refund`);
const resilience = () => request('GET', '/internal/v1/resilience');

async function openCircuit(): Promise<void> {
  await sim.configure({ mode: 'down' });
  for (let index = 0; index < 5; index += 1) {
    expect((await charge(randomUUID())).body.code).toBe('PAYMENT_CHARGE_REJECTED');
  }
  expect((await resilience()).body.circuitBreaker).toMatchObject({ state: 'OPEN' });
}

async function inDoubtCharge(orderId: string): Promise<void> {
  await sim.configure({ mode: 'slow', slowDelayMs: 1_000 });
  const pending = await charge(orderId);
  expect(pending.status).toBe(202);
  expect(pending.body).toMatchObject({ orderId, status: 'PENDING' });
}

beforeAll(async () => {
  await sim.start();
});

afterAll(() => sim.stop());

beforeEach(() => sim.configure({ mode: 'normal', latencyMs: 0, slowDelayMs: 1_000 }));

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('charge', () => {
  beforeEach(() => startApp());

  it('charges a new sale once and replays the stored result', async () => {
    const orderId = randomUUID();
    const before = sim.stats().chargesApproved;
    const first = await charge(orderId);
    const replay = await charge(orderId);
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ orderId, amountMinor: 20_000, currency: 'CLP', status: 'CHARGED' });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(sim.stats().chargesApproved - before).toBe(1);
    expect((await get(orderId)).body.status).toBe('CHARGED');
  });

  it('applies five concurrent identical charges once', async () => {
    const orderId = randomUUID();
    const before = sim.stats().chargesApproved;
    const results = await Promise.all(Array.from({ length: 5 }, () => charge(orderId)));
    for (const result of results) {
      expect([200, 201]).toContain(result.status);
      expect(result.body.status).toBe('CHARGED');
    }
    expect(sim.stats().chargesApproved - before).toBe(1);
  });

  it('rejects the same sale with a different amount or currency', async () => {
    const orderId = randomUUID();
    await charge(orderId, 20_000);
    expect((await charge(orderId, 30_000)).body.code).toBe('PAYMENT_CONFLICT');
    const conflict = await charge(orderId, 20_000, 'USD');
    expect(conflict.status).toBe(409);
  });

  it('returns 422 PAYMENT_DECLINED and repeats it without asking the gateway again', async () => {
    await sim.configure({ mode: 'decline' });
    const orderId = randomUUID();
    const first = await charge(orderId);
    const requestsAfterFirst = sim.stats().apiRequests;
    const replay = await charge(orderId);
    expect(first.status).toBe(422);
    expect(first.body.code).toBe('PAYMENT_DECLINED');
    expect(replay.status).toBe(422);
    expect(sim.stats().apiRequests).toBe(requestsAfterFirst);
    expect((await get(orderId)).body.status).toBe('DECLINED');
  });

  it('answers 503 PAYMENT_CHARGE_REJECTED and keeps no record when the gateway confirms it is down', async () => {
    await sim.configure({ mode: 'down' });
    const orderId = randomUUID();
    const rejected = await charge(orderId);
    expect(rejected.status).toBe(503);
    expect(rejected.body.code).toBe('PAYMENT_CHARGE_REJECTED');
    expect((await get(orderId)).status).toBe(404);
    await sim.configure({ mode: 'normal' });
    expect((await charge(orderId)).status).toBe(201);
  });

  it('answers 202 PENDING within the timeout and resolves the retry without a second charge', async () => {
    const orderId = randomUUID();
    const before = sim.stats().chargesApproved;
    await sim.configure({ mode: 'slow', slowDelayMs: 1_000 });
    const pending = await charge(orderId);
    expect(pending.status).toBe(202);
    expect(pending.ms).toBeLessThan(900);
    expect((await get(orderId)).body.status).toBe('PENDING');
    await sim.configure({ mode: 'normal' });
    const retry = await charge(orderId);
    expect(retry.body.status).toBe('CHARGED');
    expect(sim.stats().chargesApproved - before).toBe(1);
  });

  it('propagates a valid X-Trace-Id', async () => {
    const traceId = randomUUID();
    const reply = await request('GET', `/internal/v1/payments/${randomUUID()}`, undefined, { 'x-trace-id': traceId });
    expect(reply.status).toBe(404);
    expect(reply.headers.get('x-trace-id')).toBe(traceId);
    expect(reply.body).toMatchObject({ code: 'PAYMENT_NOT_FOUND', traceId });
  });

  it.each([
    ['not-a-uuid', { amountMinor: 1, currency: 'CLP' }],
    [randomUUID(), { amountMinor: 0, currency: 'CLP' }],
    [randomUUID(), { amountMinor: 1.5, currency: 'CLP' }],
    [randomUUID(), { amountMinor: 1, currency: 'clp' }],
    [randomUUID(), { amountMinor: 1, currency: 'CLP', extra: true }],
    [randomUUID(), { amountMinor: '1', currency: 'CLP' }],
  ])('rejects an invalid charge request %#', async (orderId, body) => {
    const reply = await request('PUT', `/internal/v1/payments/${orderId}`, body);
    expect(reply.status).toBe(400);
    expect(reply.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('circuit breaker and bulkhead', () => {
  it('opens after repeated failures, answers fast without calling the gateway and closes after a good probe', async () => {
    await startApp();
    await openCircuit();
    const requestsBefore = sim.stats().apiRequests;
    const rejected = await charge(randomUUID());
    expect(rejected.status).toBe(503);
    expect(rejected.body.code).toBe('PAYMENT_CHARGE_REJECTED');
    expect(rejected.ms).toBeLessThan(200);
    expect(sim.stats().apiRequests).toBe(requestsBefore);

    await sim.configure({ mode: 'normal' });
    await delay(550);
    expect((await charge(randomUUID())).status).toBe(201);
    expect((await resilience()).body.circuitBreaker).toMatchObject({ state: 'CLOSED', openedCount: 1 });
  });

  it('keeps serving reads from its own database while the circuit is open', async () => {
    await startApp();
    const orderId = randomUUID();
    await charge(orderId);
    await openCircuit();
    const read = await get(orderId);
    expect(read.status).toBe(200);
    expect(read.body.status).toBe('CHARGED');
  });

  it('does not promise "no charge" for a sale already sent to the gateway', async () => {
    await startApp();
    const orderId = randomUUID();
    await inDoubtCharge(orderId);
    await openCircuit();
    const retry = await charge(orderId);
    expect(retry.status).toBe(202);
    expect(retry.body.status).toBe('PENDING');
  });

  it('rejects with PAYMENT_CHARGE_REJECTED when the bulkhead is full', async () => {
    await startApp({ bulkhead: { enabled: true, maxConcurrent: 1 }, gateway: { baseUrl: sim.baseUrl, timeoutMs: 1_000 } });
    await sim.configure({ mode: 'slow', slowDelayMs: 300 });
    const slow = charge(randomUUID());
    await delay(50);
    const rejected = await charge(randomUUID());
    expect(rejected.status).toBe(503);
    expect(rejected.body.code).toBe('PAYMENT_CHARGE_REJECTED');
    expect(String(rejected.body.message)).toContain('concurrency');
    expect((await slow).status).toBe(201);
    expect((await resilience()).body.bulkhead).toMatchObject({ rejectedCalls: 1, peakInFlight: 1, inFlight: 0 });
  });

  it('lets every call through when protections are disabled', async () => {
    const base = testConfig(testDatabaseUrl(), sim.baseUrl);
    await startApp({ circuitBreaker: { ...base.circuitBreaker, enabled: false }, bulkhead: { enabled: false, maxConcurrent: 1 } });
    await sim.configure({ mode: 'down' });
    const before = sim.stats().rejectedWhileDown;
    for (let index = 0; index < 8; index += 1) await charge(randomUUID());
    expect(sim.stats().rejectedWhileDown - before).toBe(8);
    expect((await resilience()).body.circuitBreaker).toMatchObject({ enabled: false, state: 'CLOSED' });
  });
});

describe('refund', () => {
  beforeEach(() => startApp());

  it('refunds a charged sale once and blocks a later charge', async () => {
    const orderId = randomUUID();
    await charge(orderId);
    const before = sim.stats().refunds;
    const first = await refund(orderId);
    const replay = await refund(orderId);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ orderId, amountMinor: 20_000, currency: 'CLP', status: 'REFUNDED' });
    expect(replay.status).toBe(200);
    expect(sim.stats().refunds - before).toBe(1);
    const recharge = await charge(orderId);
    expect(recharge.status).toBe(409);
    expect(recharge.body.code).toBe('PAYMENT_ALREADY_REFUNDED');
  });

  it('answers 404 for a sale without payment and 409 for a declined charge', async () => {
    expect((await refund(randomUUID())).status).toBe(404);
    await sim.configure({ mode: 'decline' });
    const orderId = randomUUID();
    await charge(orderId);
    const declined = await refund(orderId);
    expect(declined.status).toBe(409);
    expect(declined.body.code).toBe('PAYMENT_NOT_REFUNDABLE');
  });

  it('keeps REFUND_PENDING while the gateway is down and finishes on retry', async () => {
    const orderId = randomUUID();
    await charge(orderId);
    await sim.configure({ mode: 'down' });
    const pending = await refund(orderId);
    expect(pending.status).toBe(202);
    expect(pending.body.status).toBe('REFUND_PENDING');
    await sim.configure({ mode: 'normal' });
    expect((await refund(orderId)).body.status).toBe('REFUNDED');
  });

  it('refunds an in-doubt charge that the gateway did apply', async () => {
    const orderId = randomUUID();
    await inDoubtCharge(orderId);
    await sim.configure({ mode: 'normal' });
    const before = sim.stats().refunds;
    expect((await refund(orderId)).body.status).toBe('REFUNDED');
    expect(sim.stats().refunds - before).toBe(1);
  });

  it('voids an in-doubt charge that never reached the gateway', async () => {
    const orderId = randomUUID();
    const db = app!.get(PaymentsDatabase);
    await db.payment.create({ data: { orderId, amountMinor: 10_000, currency: 'CLP', gatewayAttempts: 1 } });
    const before = sim.stats().voids;
    expect((await refund(orderId)).body.status).toBe('REFUNDED');
    expect(sim.stats().voids - before).toBe(1);
    expect((await db.payment.findUniqueOrThrow({ where: { orderId } })).refundOutcome).toBe('VOIDED');
  });

  it('answers 503 PAYMENT_REFUND_REJECTED while the circuit is open and keeps the charge', async () => {
    const orderId = randomUUID();
    await charge(orderId);
    await openCircuit();
    const rejected = await refund(orderId);
    expect(rejected.status).toBe(503);
    expect(rejected.body.code).toBe('PAYMENT_REFUND_REJECTED');
    expect((await get(orderId)).body.status).toBe('CHARGED');
  });
});

describe('reconciler', () => {
  beforeEach(() => startApp());

  it('resolves an in-doubt charge by looking it up in the gateway', async () => {
    const orderId = randomUUID();
    const approvedBefore = sim.stats().chargesApproved;
    await inDoubtCharge(orderId);
    await sim.configure({ mode: 'normal' });
    await delay(650);
    expect(await app!.get(PaymentsReconciler).runOnce()).toBe(1);
    expect((await get(orderId)).body.status).toBe('CHARGED');
    expect(sim.stats().chargesApproved - approvedBefore).toBe(1);
  });

  it('leaves a charge the gateway never saw as PENDING without charging it', async () => {
    const orderId = randomUUID();
    const db = app!.get(PaymentsDatabase);
    await db.payment.create({
      data: { orderId, amountMinor: 10_000, currency: 'CLP', gatewayAttempts: 1, updatedAt: new Date(Date.now() - 10_000) },
    });
    const approvedBefore = sim.stats().chargesApproved;
    expect(await app!.get(PaymentsReconciler).runOnce()).toBe(0);
    expect((await get(orderId)).body.status).toBe('PENDING');
    expect(sim.stats().chargesApproved).toBe(approvedBefore);
  });
});
