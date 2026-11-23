import type { PaymentsConfig } from '../src/config.js';

export function testConfig(databaseUrl: string, gatewayUrl: string, overrides: Partial<PaymentsConfig> = {}): PaymentsConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    databaseUrl,
    gateway: { baseUrl: gatewayUrl, timeoutMs: 300 },
    circuitBreaker: {
      enabled: true,
      windowSize: 10,
      minimumCalls: 5,
      failureRateThreshold: 50,
      openMs: 500,
      halfOpenMaxCalls: 1,
    },
    bulkhead: { enabled: true, maxConcurrent: 8 },
    reconcileIntervalMs: 0,
    ...overrides,
  };
}
