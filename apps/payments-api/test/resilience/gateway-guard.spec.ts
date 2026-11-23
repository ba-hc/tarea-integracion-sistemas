import { describe, expect, it } from 'vitest';
import type { PaymentsConfig } from '../../src/config.js';
import { Bulkhead } from '../../src/resilience/bulkhead.js';
import { GatewayGuard } from '../../src/resilience/gateway-guard.js';
import { testConfig } from '../test-config.js';

function guard(overrides: Partial<PaymentsConfig> = {}) {
  return new GatewayGuard({ ...testConfig('postgresql://unused/test', 'http://unused'), ...overrides });
}

describe('Bulkhead', () => {
  it('rejects beyond maxConcurrent and frees a slot on release', () => {
    const bulkhead = new Bulkhead(2);
    expect(bulkhead.tryAcquire()).toBe(true);
    expect(bulkhead.tryAcquire()).toBe(true);
    expect(bulkhead.tryAcquire()).toBe(false);
    bulkhead.release();
    expect(bulkhead.tryAcquire()).toBe(true);
    expect(bulkhead.snapshot()).toEqual({ maxConcurrent: 2, inFlight: 2, peakInFlight: 2, rejectedCalls: 1 });
  });
});

describe('GatewayGuard', () => {
  it('rejects with BULKHEAD_FULL when every slot is busy', () => {
    const instance = guard({ bulkhead: { enabled: true, maxConcurrent: 1 } });
    const first = instance.admit();
    expect(first.admitted).toBe(true);
    expect(instance.admit()).toEqual({ admitted: false, reason: 'BULKHEAD_FULL' });
    if (first.admitted) first.release('success');
    expect(instance.admit().admitted).toBe(true);
  });

  it('rejects with CIRCUIT_OPEN before touching the bulkhead', () => {
    const instance = guard();
    for (let index = 0; index < 5; index += 1) {
      const admission = instance.admit();
      if (admission.admitted) admission.release('failure');
    }
    expect(instance.admit()).toEqual({ admitted: false, reason: 'CIRCUIT_OPEN' });
    expect(instance.snapshot().bulkhead.rejectedCalls).toBe(0);
  });

  it('ignores a release called twice', () => {
    const instance = guard({ bulkhead: { enabled: true, maxConcurrent: 1 } });
    const admission = instance.admit();
    if (!admission.admitted) throw new Error('expected admission');
    admission.release('success');
    admission.release('success');
    expect(instance.snapshot().bulkhead.inFlight).toBe(0);
    expect(instance.snapshot().circuitBreaker.successCalls).toBe(1);
  });

  it('admits everything when both protections are disabled', () => {
    const instance = guard({
      circuitBreaker: { ...testConfig('postgresql://unused/test', 'http://unused').circuitBreaker, enabled: false },
      bulkhead: { enabled: false, maxConcurrent: 1 },
    });
    for (let index = 0; index < 20; index += 1) {
      const admission = instance.admit();
      expect(admission.admitted).toBe(true);
      if (admission.admitted) admission.release('failure');
    }
    expect(instance.snapshot().circuitBreaker.state).toBe('CLOSED');
  });
});
