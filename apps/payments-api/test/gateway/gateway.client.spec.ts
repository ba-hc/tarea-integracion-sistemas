import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GatewayClient, breakerOutcome } from '../../src/gateway/gateway.client.js';
import { GatewaySim, closedPortUrl } from '../gateway-sim.js';

const sim = new GatewaySim();
let client: GatewayClient;

beforeAll(async () => {
  const baseUrl = await sim.start();
  client = new GatewayClient({ gateway: { baseUrl, timeoutMs: 200 } });
});

afterAll(() => sim.stop());

beforeEach(() => sim.configure({ mode: 'normal', latencyMs: 0, slowDelayMs: 1_000 }));

describe('GatewayClient', () => {
  it('charges once per order even when the charge is repeated', async () => {
    const orderId = randomUUID();
    const first = await client.charge(orderId, 20_000, 'CLP', randomUUID());
    const replay = await client.charge(orderId, 20_000, 'CLP', randomUUID());
    expect(first.kind).toBe('approved');
    expect(replay).toEqual(first);
    expect(breakerOutcome(first)).toBe('success');
  });

  it('classifies a declined charge as a business result', async () => {
    await sim.configure({ mode: 'decline' });
    const result = await client.charge(randomUUID(), 10_000, 'CLP', randomUUID());
    expect(result).toEqual({ kind: 'declined' });
    expect(breakerOutcome(result)).toBe('success');
  });

  it('classifies GATEWAY_UNAVAILABLE as not applied and a failure for the breaker', async () => {
    await sim.configure({ mode: 'down' });
    const result = await client.charge(randomUUID(), 10_000, 'CLP', randomUUID());
    expect(result).toEqual({ kind: 'not_applied' });
    expect(breakerOutcome(result)).toBe('failure');
  });

  it('classifies a refused connection as not applied', async () => {
    const offline = new GatewayClient({ gateway: { baseUrl: await closedPortUrl(), timeoutMs: 200 } });
    expect(await offline.charge(randomUUID(), 10_000, 'CLP', randomUUID())).toEqual({ kind: 'not_applied' });
  });

  it('treats a timeout as uncertain because the charge may have been applied', async () => {
    await sim.configure({ mode: 'slow', slowDelayMs: 500 });
    const orderId = randomUUID();
    const startedAt = performance.now();
    const result = await client.charge(orderId, 10_000, 'CLP', randomUUID());
    expect(performance.now() - startedAt).toBeLessThan(450);
    expect(result).toEqual({ kind: 'uncertain', reason: 'timeout' });
    expect(breakerOutcome(result)).toBe('failure');
    await sim.configure({ mode: 'normal' });
    expect(await client.lookup(orderId, randomUUID())).toMatchObject({ kind: 'found', status: 'APPROVED' });
  });

  it('refunds an approved charge and voids a charge that never arrived', async () => {
    const charged = randomUUID();
    await client.charge(charged, 10_000, 'CLP', randomUUID());
    expect(await client.refund(charged, randomUUID())).toEqual({ kind: 'refunded' });
    const neverCharged = randomUUID();
    expect(await client.refund(neverCharged, randomUUID())).toEqual({ kind: 'voided' });
    expect(await client.charge(neverCharged, 10_000, 'CLP', randomUUID())).toEqual({ kind: 'voided' });
  });

  it('reports a declined charge as not refundable', async () => {
    await sim.configure({ mode: 'decline' });
    const orderId = randomUUID();
    await client.charge(orderId, 10_000, 'CLP', randomUUID());
    expect(await client.refund(orderId, randomUUID())).toEqual({ kind: 'not_refundable' });
  });

  it('looks up a missing charge without creating it', async () => {
    const orderId = randomUUID();
    expect(await client.lookup(orderId, randomUUID())).toEqual({ kind: 'missing' });
    expect(await client.lookup(orderId, randomUUID())).toEqual({ kind: 'missing' });
  });
});
