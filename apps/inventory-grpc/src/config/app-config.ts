import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const APP_CONFIG = Symbol('APP_CONFIG');

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface AppConfig {
  databaseUrl: string;
  grpcHost: string;
  grpcPort: number;
  protoPath: string;
  /** json: una línea JSON por evento (Docker/Compose). text: legible en consola. */
  logFormat: 'json' | 'text';
  /** Nivel mínimo: se registran este nivel y los más graves. */
  logLevel: LogLevel;
  /** Expone grpc.reflection para herramientas como grpcurl. */
  reflectionEnabled: boolean;
  /** Cada cuánto el health check comprueba la base de datos. */
  healthCheckIntervalMs: number;
  /** Tiempo máximo para terminar las llamadas en curso al apagar; luego se fuerza la salida. */
  shutdownTimeoutMs: number;
}

// Relativa al directorio del servicio (apps/inventory-grpc), que es el cwd
// tanto con `npm run` como en el contenedor.
const DEFAULT_PROTO_PATH = '../../contracts/grpc/repuestossur/inventory/v1/inventory.proto';

export class ConfigError extends Error {}

function readInteger(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} debe ser un entero entre ${min} y ${max}: "${raw}"`);
  }
  return value;
}

function readBoolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  if (raw === 'true' || raw === '1') {
    return true;
  }
  if (raw === 'false' || raw === '0') {
    return false;
  }
  throw new ConfigError(`${name} debe ser true o false: "${raw}"`);
}

function readChoice<T extends string>(env: NodeJS.ProcessEnv, name: string, choices: readonly T[], fallback: T): T {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  if (!(choices as readonly string[]).includes(raw)) {
    throw new ConfigError(`${name} debe ser uno de ${choices.join(', ')}: "${raw}"`);
  }
  return raw as T;
}

function readDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const raw = env.DATABASE_URL?.trim();
  if (!raw) {
    throw new ConfigError('DATABASE_URL es obligatoria');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // No se incluye el valor: podría contener la contraseña.
    throw new ConfigError('DATABASE_URL no es una URL válida');
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new ConfigError(`DATABASE_URL debe ser postgresql://, no ${url.protocol}//`);
  }
  return raw;
}

/** Lee y valida la configuración. Falla al arrancar en vez de a mitad de una llamada. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const protoPath = resolve(env.INVENTORY_PROTO_PATH?.trim() || DEFAULT_PROTO_PATH);
  if (!existsSync(protoPath)) {
    throw new ConfigError(`no existe el contrato gRPC en ${protoPath} (INVENTORY_PROTO_PATH)`);
  }

  return {
    databaseUrl: readDatabaseUrl(env),
    grpcHost: env.GRPC_HOST?.trim() || '0.0.0.0',
    grpcPort: readInteger(env, 'GRPC_PORT', 50051, 1, 65535),
    protoPath,
    logFormat: readChoice(env, 'LOG_FORMAT', ['json', 'text'] as const, 'json'),
    logLevel: readChoice(env, 'LOG_LEVEL', LOG_LEVELS, 'log'),
    reflectionEnabled: readBoolean(env, 'GRPC_REFLECTION', true),
    healthCheckIntervalMs: readInteger(env, 'HEALTH_CHECK_INTERVAL_MS', 5_000, 500, 60_000),
    shutdownTimeoutMs: readInteger(env, 'SHUTDOWN_TIMEOUT_MS', 8_000, 1_000, 60_000),
  };
}

/** DATABASE_URL sin usuario ni contraseña, apta para logs. */
export function describeDatabase(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  return `${url.hostname}:${url.port || '5432'}${url.pathname}`;
}
