import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const base = { DATABASE_URL: 'postgresql://payments@localhost/payments' };

describe('loadConfig', () => {
  it('uses protected defaults with a gateway timeout below the Sales deadline', () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({
      port: 3003,
      gateway: { baseUrl: 'http://payment-gateway-sim:3010', timeoutMs: 1_200 },
      circuitBreaker: { enabled: true, windowSize: 10, minimumCalls: 5, failureRateThreshold: 50, openMs: 5_000, halfOpenMaxCalls: 1 },
      bulkhead: { enabled: true, maxConcurrent: 8 },
      reconcileIntervalMs: 5_000,
    });
    expect(config.gateway.timeoutMs).toBeLessThan(2_000);
  });

  it('can disable each protection for the experiment', () => {
    const config = loadConfig({
      ...base,
      PAYMENTS_CIRCUIT_BREAKER_ENABLED: 'false',
      PAYMENTS_BULKHEAD_ENABLED: 'false',
      PAYMENTS_GATEWAY_TIMEOUT_MS: '30000',
    });
    expect(config.circuitBreaker.enabled).toBe(false);
    expect(config.bulkhead.enabled).toBe(false);
    expect(config.gateway.timeoutMs).toBe(30_000);
  });

  it.each([
    [{}, 'DATABASE_URL'],
    [{ ...base, PAYMENTS_BULKHEAD_ENABLED: 'yes' }, 'PAYMENTS_BULKHEAD_ENABLED'],
    [{ ...base, PAYMENTS_GATEWAY_TIMEOUT_MS: '1.5' }, 'PAYMENTS_GATEWAY_TIMEOUT_MS'],
    [{ ...base, PAYMENTS_CB_FAILURE_RATE_THRESHOLD: '0' }, 'PAYMENTS_CB_FAILURE_RATE_THRESHOLD'],
    [{ ...base, PAYMENTS_CB_MINIMUM_CALLS: '20' }, 'PAYMENTS_CB_MINIMUM_CALLS'],
    [{ ...base, PAYMENT_GATEWAY_URL: 'ftp://gateway' }, 'PAYMENT_GATEWAY_URL'],
  ])('rejects invalid configuration %#', (env, name) => {
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(name);
  });
});
