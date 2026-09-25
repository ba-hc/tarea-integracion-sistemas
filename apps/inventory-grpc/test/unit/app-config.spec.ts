import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/app-config.js';

const DATABASE_URL = 'postgresql://u:p@localhost:5432/inventory';

describe('loadConfig', () => {
  it('aplica valores por defecto', () => {
    expect(loadConfig({ DATABASE_URL })).toEqual({
      databaseUrl: DATABASE_URL,
      grpcHost: '0.0.0.0',
      grpcPort: 50051,
      protoPath: resolve('../../contracts/grpc/repuestossur/inventory/v1/inventory.proto'),
    });
  });

  it('lee host, puerto y ruta del proto desde el entorno', () => {
    const config = loadConfig({
      DATABASE_URL,
      GRPC_HOST: '127.0.0.1',
      GRPC_PORT: '6000',
      INVENTORY_PROTO_PATH: '/contracts/inventory.proto',
    });
    expect(config.grpcHost).toBe('127.0.0.1');
    expect(config.grpcPort).toBe(6000);
    expect(config.protoPath).toBe(resolve('/contracts/inventory.proto'));
  });

  it('exige DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ DATABASE_URL: '  ' })).toThrow(ConfigError);
  });

  it.each(['0', '65536', 'abc', '50051.5'])('rechaza GRPC_PORT=%s', (port) => {
    expect(() => loadConfig({ DATABASE_URL, GRPC_PORT: port })).toThrow(ConfigError);
  });
});
