import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import { configFromEnv, createSimulator } from '../src/simulator.mjs';

let simulator;
let server;
let baseUrl;

async function call(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const charge = (key, amountMinor = 20_000) => call('POST', '/v1/charges', { idempotencyKey: key, amountMinor, currency: 'CLP' });
const refund = (key, chargeKey) => call('POST', '/v1/refunds', { idempotencyKey: key, chargeIdempotencyKey: chargeKey });
const setMode = (config) => call('PUT', '/admin/config', config);

before(async () => {
  simulator = createSimulator({ mode: 'normal', latencyMs: 0, slowDelayMs: 300 });
  server = createServer((request, response) => void simulator.handle(request, response));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  simulator.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  await setMode({ mode: 'normal', latencyMs: 0, slowDelayMs: 300 });
});

describe('charges', () => {
  it('approves once per idempotency key and replays the same charge', async () => {
    const first = await charge('charge-a');
    const replay = await charge('charge-a');
    assert.equal(first.status, 200);
    assert.equal(first.body.status, 'APPROVED');
    assert.deepEqual(replay.body, first.body);
  });

  it('applies concurrent requests with the same key once', async () => {
    const before = simulator.stats().chargesApproved;
    const results = await Promise.all(Array.from({ length: 10 }, () => charge('charge-concurrent')));
    assert.equal(new Set(results.map((result) => result.body.chargeId)).size, 1);
    assert.equal(simulator.stats().chargesApproved - before, 1);
  });

  it('rejects a reused key with a different amount', async () => {
    await charge('charge-b', 10_000);
    const conflict = await charge('charge-b', 30_000);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'IDEMPOTENCY_CONFLICT');
  });

  it('declines new charges in decline mode', async () => {
    await setMode({ mode: 'decline' });
    const declined = await charge('charge-c');
    assert.equal(declined.body.status, 'DECLINED');
  });

  it('answers 503 without applying anything in down mode', async () => {
    await setMode({ mode: 'down' });
    const down = await charge('charge-d');
    assert.equal(down.status, 503);
    assert.equal(down.body.code, 'GATEWAY_UNAVAILABLE');
    await setMode({ mode: 'normal' });
    assert.equal((await call('GET', '/v1/charges/charge-d')).status, 404);
  });

  it('applies the charge on arrival in slow mode even if the client gives up', async () => {
    await setMode({ mode: 'slow', slowDelayMs: 500 });
    await assert.rejects(fetch(`${baseUrl}/v1/charges`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: 'charge-e', amountMinor: 1, currency: 'CLP' }),
      signal: AbortSignal.timeout(50),
    }));
    await setMode({ mode: 'normal' });
    const lookup = await call('GET', '/v1/charges/charge-e');
    assert.equal(lookup.status, 200);
    assert.equal(lookup.body.status, 'APPROVED');
  });
});

describe('refunds', () => {
  it('refunds an approved charge once and replays the result', async () => {
    await charge('charge-f');
    const first = await refund('refund-f', 'charge-f');
    const replay = await refund('refund-f', 'charge-f');
    assert.equal(first.body.status, 'REFUNDED');
    assert.deepEqual(replay.body, first.body);
    assert.equal((await call('GET', '/v1/charges/charge-f')).body.status, 'REFUNDED');
  });

  it('voids a charge key that never arrived so a late charge has no effect', async () => {
    const voided = await refund('refund-g', 'charge-g');
    assert.equal(voided.body.status, 'VOIDED');
    const late = await charge('charge-g');
    assert.equal(late.body.status, 'VOIDED');
  });

  it('refuses to refund a declined charge', async () => {
    await setMode({ mode: 'decline' });
    await charge('charge-h');
    const result = await refund('refund-h', 'charge-h');
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'CHARGE_NOT_REFUNDABLE');
  });
});

describe('configuration', () => {
  it('validates admin updates', async () => {
    const apiRequests = simulator.stats().apiRequests;
    assert.equal((await setMode({ mode: 'broken' })).status, 400);
    assert.equal((await call('GET', '/health')).status, 200);
    assert.equal(simulator.stats().apiRequests, apiRequests);
    assert.equal((await setMode({ other: 1 })).status, 400);
    const current = await call('GET', '/admin/config');
    assert.equal(current.body.mode, 'normal');
  });

  it('reads defaults and rejects invalid environment values', () => {
    assert.deepEqual(configFromEnv({}), { mode: 'normal', latencyMs: 20, slowDelayMs: 3000 });
    assert.throws(() => configFromEnv({ GATEWAY_SIM_MODE: 'off' }));
    assert.throws(() => configFromEnv({ GATEWAY_SIM_LATENCY_MS: '-1' }));
  });
});
