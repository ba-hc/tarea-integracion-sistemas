import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, describeDatabase, loadConfig } from '../../src/config/app-config.js';

const DATABASE_URL = 'postgresql://inventory:s3cret@db:5432/inventory';
const PROTO = resolve('../../contracts/grpc/repuestossur/inventory/v1/inventory.proto');

describe('loadConfig', () => {
  it('aplica valores por defecto', () => {
    expect(loadConfig({ DATABASE_URL })).toEqual({
      databaseUrl: DATABASE_URL,
      grpcHost: '0.0.0.0',
      grpcPort: 50051,
      protoPath: PROTO,
      logFormat: 'json',
      logLevel: 'log',
      reflectionEnabled: true,
      healthCheckIntervalMs: 5_000,
      shutdownTimeoutMs: 8_000,
    });
  });

  it('lee todas las variables del entorno', () => {
    expect(
      loadConfig({
        DATABASE_URL,
        GRPC_HOST: '127.0.0.1',
        GRPC_PORT: '6000',
        INVENTORY_PROTO_PATH: PROTO,
        LOG_FORMAT: 'TEXT',
        LOG_LEVEL: 'debug',
        GRPC_REFLECTION: 'false',
        HEALTH_CHECK_INTERVAL_MS: '1000',
        SHUTDOWN_TIMEOUT_MS: '3000',
      }),
    ).toMatchObject({
      grpcHost: '127.0.0.1',
      grpcPort: 6000,
      logFormat: 'text',
      logLevel: 'debug',
      reflectionEnabled: false,
      healthCheckIntervalMs: 1000,
      shutdownTimeoutMs: 3000,
    });
  });

  it('acepta postgres:// además de postgresql://', () => {
    expect(loadConfig({ DATABASE_URL: 'postgres://u:p@h/db' }).databaseUrl).toBe('postgres://u:p@h/db');
  });

  it.each<[string, NodeJS.ProcessEnv]>([
    ['DATABASE_URL ausente', {}],
    ['DATABASE_URL vacía', { DATABASE_URL: '  ' }],
    ['DATABASE_URL no es URL', { DATABASE_URL: 'inventory' }],
    ['DATABASE_URL de otro motor', { DATABASE_URL: 'mysql://u:p@h/db' }],
    ['GRPC_PORT 0', { DATABASE_URL, GRPC_PORT: '0' }],
    ['GRPC_PORT 65536', { DATABASE_URL, GRPC_PORT: '65536' }],
    ['GRPC_PORT no numérico', { DATABASE_URL, GRPC_PORT: 'abc' }],
    ['GRPC_PORT decimal', { DATABASE_URL, GRPC_PORT: '50051.5' }],
    ['LOG_FORMAT desconocido', { DATABASE_URL, LOG_FORMAT: 'xml' }],
    ['LOG_LEVEL desconocido', { DATABASE_URL, LOG_LEVEL: 'trace' }],
    ['GRPC_REFLECTION no booleano', { DATABASE_URL, GRPC_REFLECTION: 'yes' }],
    ['HEALTH_CHECK_INTERVAL_MS demasiado bajo', { DATABASE_URL, HEALTH_CHECK_INTERVAL_MS: '10' }],
    ['SHUTDOWN_TIMEOUT_MS demasiado alto', { DATABASE_URL, SHUTDOWN_TIMEOUT_MS: '600000' }],
    ['.proto inexistente', { DATABASE_URL, INVENTORY_PROTO_PATH: '/no/existe/inventory.proto' }],
  ])('rechaza %s', (_label, env) => {
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  it('nunca incluye la DATABASE_URL en el mensaje de error', () => {
    expect(() => loadConfig({ DATABASE_URL: 'mysql://inventory:s3cret@h/db' })).toThrow(/^(?!.*s3cret)/);
    expect(() => loadConfig({ DATABASE_URL: 'not a url s3cret' })).toThrow(/^(?!.*s3cret)/);
  });
});

describe('describeDatabase', () => {
  it('omite usuario y contraseña', () => {
    expect(describeDatabase(DATABASE_URL)).toBe('db:5432/inventory');
  });

  it('usa el puerto por defecto si no viene', () => {
    expect(describeDatabase('postgresql://u:p@db/inventory')).toBe('db:5432/inventory');
  });
});
