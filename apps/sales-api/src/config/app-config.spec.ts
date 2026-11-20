import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadSalesConfig } from './app-config.js';

function testEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgresql://sales:password@localhost/sales',
    API_KEY_READER: 'reader-test-key',
    API_KEY_OPERATOR: 'operator-test-key',
    INVENTORY_PROTO_PATH: resolve(process.cwd(), '../../contracts/grpc/repuestossur/inventory/v1/inventory.proto'),
    ...extra,
  };
}

describe('Sales runtime configuration', () => {
  it('uses the frozen 800 ms Inventory deadline unless overridden', () => {
    expect(loadSalesConfig(testEnvironment()).inventoryRpcDeadlineMs).toBe(800);
    expect(loadSalesConfig(testEnvironment({ INVENTORY_RPC_DEADLINE_MS: '60000' })).inventoryRpcDeadlineMs).toBe(60_000);
  });

  it('rejects malformed deadlines and identical role keys without exposing values', () => {
    expect(() => loadSalesConfig(testEnvironment({ INVENTORY_RPC_DEADLINE_MS: 'slow' }))).toThrow(ConfigError);
    expect(() => loadSalesConfig(testEnvironment({ API_KEY_OPERATOR: 'reader-test-key' }))).toThrow(
      'API_KEY_READER and API_KEY_OPERATOR must be different',
    );
  });
});
describe('Saga configuration (T2)', () => {
  it('runs the three steps with a configurable unit price in CLP by default', () => {
    const { saga } = loadSalesConfig(testEnvironment());
    expect(saga.steps).toEqual(['stock', 'payment', 'dispatch']);
    expect(saga.unitPriceMinor).toBe(10_000);
    expect(saga.currency).toBe('CLP');
    expect(saga.paymentsTimeoutMs).toBe(2_000);
    expect(saga.dispatchTimeoutMs).toBe(1_500);
    expect(saga.paymentsBaseUrl).toBe('http://payments-api:3003');
    expect(saga.dispatchBaseUrl).toBe('http://dispatch-api:3001');
  });

  it('accepts an ordered subset of steps that starts with stock', () => {
    expect(loadSalesConfig(testEnvironment({ SAGA_STEPS: 'stock' })).saga.steps).toEqual(['stock']);
    expect(loadSalesConfig(testEnvironment({ SAGA_STEPS: 'stock,dispatch' })).saga.steps).toEqual(['stock', 'dispatch']);
    for (const value of ['payment,stock', 'payment', 'stock,stock', 'stock,refund', 'dispatch,stock']) {
      expect(() => loadSalesConfig(testEnvironment({ SAGA_STEPS: value }))).toThrow(ConfigError);
    }
  });

  it('keeps the lease longer than a full run even with a long experimental deadline', () => {
    const { saga } = loadSalesConfig(testEnvironment({ INVENTORY_RPC_DEADLINE_MS: '60000' }));
    expect(saga.leaseMs).toBeGreaterThan(2 * (60_000 + 2_000 + 1_500));
    expect(saga.abortAfterMs).toBeGreaterThanOrEqual(saga.leaseMs);
    expect(() => loadSalesConfig(testEnvironment({ SAGA_LEASE_MS: '5000' }))).toThrow('SAGA_LEASE_MS must be greater than');
    expect(() => loadSalesConfig(testEnvironment({ SAGA_ABORT_AFTER_MS: '1000' }))).toThrow(ConfigError);
  });

  it('rejects base URLs with credentials and invalid currencies', () => {
    expect(() => loadSalesConfig(testEnvironment({ PAYMENTS_BASE_URL: 'http://user:secret@payments:3003' }))).toThrow(ConfigError);
    expect(() => loadSalesConfig(testEnvironment({ DISPATCH_BASE_URL: 'ftp://dispatch' }))).toThrow(ConfigError);
    expect(() => loadSalesConfig(testEnvironment({ SALE_CURRENCY: 'pesos' }))).toThrow(ConfigError);
    expect(loadSalesConfig(testEnvironment({ PAYMENTS_BASE_URL: 'http://payments:3003/' })).saga.paymentsBaseUrl).toBe('http://payments:3003');
  });
});
