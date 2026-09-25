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