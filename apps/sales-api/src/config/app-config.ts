import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const SALES_CONFIG = Symbol('SALES_CONFIG');
export type ApiKeyRole = 'reader' | 'operator';

export interface SalesConfig {
  host: string;
  port: number;
  databaseUrl: string;
  apiKeyReader: string;
  apiKeyOperator: string;
  inventoryGrpcUrl: string;
  inventoryRpcDeadlineMs: number;
  inventoryProtoPath: string;
  /** T2: Saga de venta. Ver docs/t2/P3-SAGA.md. */
  saga: SagaConfig;
}

/** Pasos de la Saga, en el orden en que se ejecutan. */
export const SAGA_STEP_ORDER = ['stock', 'payment', 'dispatch'] as const;
export type SagaStepName = (typeof SAGA_STEP_ORDER)[number];

export interface SagaConfig {
  /** Pasos activos, subconjunto ordenado de SAGA_STEP_ORDER que siempre incluye `stock`. */
  steps: SagaStepName[];
  paymentsBaseUrl: string;
  paymentsTimeoutMs: number;
  dispatchBaseUrl: string;
  dispatchTimeoutMs: number;
  /** Precio unitario de un repuesto en la unidad menor de la moneda (CLP no tiene decimales). */
  unitPriceMinor: number;
  currency: string;
  /** Duración del lease que da a un único proceso el derecho a avanzar una Saga. */
  leaseMs: number;
  /** Tiempo que una Saga con un paso en duda espera un reintento antes de que el recuperador la aborte. */
  abortAfterMs: number;
  recoveryEnabled: boolean;
  recoveryIntervalMs: number;
  /** Tope del backoff exponencial entre intentos de una compensación pendiente. */
  maxBackoffMs: number;
}

export class ConfigError extends Error {}

const DEFAULT_PROTO_PATH = '../../contracts/grpc/repuestossur/inventory/v1/inventory.proto';

function readInteger(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(`${name} is required`);
  return value;
}

function readDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const value = required(env, 'DATABASE_URL');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError('DATABASE_URL must be a valid PostgreSQL URL');
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new ConfigError('DATABASE_URL must use postgresql://');
  }
  return value;
}

function readBaseUrl(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name]?.trim() || fallback;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} must be a valid http(s) URL`);
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) {
    throw new ConfigError(`${name} must be an http(s) URL without credentials, query or fragment`);
  }
  return value.replace(/\/+$/, '');
}

function readBoolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new ConfigError(`${name} must be true or false`);
}

function readSagaSteps(env: NodeJS.ProcessEnv): SagaStepName[] {
  const raw = env.SAGA_STEPS?.trim();
  if (!raw) return [...SAGA_STEP_ORDER];
  const names = raw.split(',').map((name) => name.trim());
  const valid = names.every((name): name is SagaStepName => (SAGA_STEP_ORDER as readonly string[]).includes(name));
  const ordered = SAGA_STEP_ORDER.filter((step) => names.includes(step));
  if (!valid || ordered.length !== names.length || ordered.some((step, index) => step !== names[index]) || ordered[0] !== 'stock') {
    throw new ConfigError('SAGA_STEPS must be an ordered, comma-separated subset of stock,payment,dispatch that starts with stock');
  }
  return ordered;
}

function loadSagaConfig(env: NodeJS.ProcessEnv, inventoryRpcDeadlineMs: number): SagaConfig {
  const currency = env.SALE_CURRENCY?.trim() || 'CLP';
  if (!/^[A-Z]{3}$/.test(currency)) throw new ConfigError('SALE_CURRENCY must be an ISO 4217 code such as CLP');
  const paymentsTimeoutMs = readInteger(env, 'PAYMENTS_TIMEOUT_MS', 2_000, 1, 120_000);
  const dispatchTimeoutMs = readInteger(env, 'DISPATCH_TIMEOUT_MS', 1_500, 1, 120_000);

  // Un recorrido completo (tres pasos y sus tres compensaciones) debe caber en
  // el lease; si no, otro proceso podría avanzar la misma Saga en paralelo.
  const worstCaseRunMs = 2 * (inventoryRpcDeadlineMs + paymentsTimeoutMs + dispatchTimeoutMs);
  const leaseMs = readInteger(env, 'SAGA_LEASE_MS', Math.max(30_000, worstCaseRunMs + 5_000), 1_000, 3_600_000);
  if (leaseMs <= worstCaseRunMs) {
    throw new ConfigError(`SAGA_LEASE_MS must be greater than ${worstCaseRunMs} (two times the sum of all call timeouts)`);
  }
  // Abortar un paso en duda sólo es seguro cuando ninguna llamada original
  // puede seguir en curso: el plazo de aborto no puede ser menor que el lease.
  const abortAfterMs = readInteger(env, 'SAGA_ABORT_AFTER_MS', leaseMs, 1_000, 86_400_000);
  if (abortAfterMs < leaseMs) {
    throw new ConfigError('SAGA_ABORT_AFTER_MS must be greater than or equal to SAGA_LEASE_MS');
  }

  return {
    steps: readSagaSteps(env),
    paymentsBaseUrl: readBaseUrl(env, 'PAYMENTS_BASE_URL', 'http://payments-api:3003'),
    paymentsTimeoutMs,
    dispatchBaseUrl: readBaseUrl(env, 'DISPATCH_BASE_URL', 'http://dispatch-api:3001'),
    dispatchTimeoutMs,
    unitPriceMinor: readInteger(env, 'SALE_UNIT_PRICE_MINOR', 10_000, 1, 100_000_000),
    currency,
    leaseMs,
    abortAfterMs,
    recoveryEnabled: readBoolean(env, 'SAGA_RECOVERY_ENABLED', true),
    recoveryIntervalMs: readInteger(env, 'SAGA_RECOVERY_INTERVAL_MS', 2_000, 100, 600_000),
    maxBackoffMs: readInteger(env, 'SAGA_MAX_BACKOFF_MS', 60_000, 100, 3_600_000),
  };
}

export function loadSalesConfig(env: NodeJS.ProcessEnv = process.env): SalesConfig {
  const apiKeyReader = required(env, 'API_KEY_READER');
  const apiKeyOperator = required(env, 'API_KEY_OPERATOR');
  if (apiKeyReader === apiKeyOperator) {
    throw new ConfigError('API_KEY_READER and API_KEY_OPERATOR must be different');
  }

  const inventoryProtoPath = resolve(env.INVENTORY_PROTO_PATH?.trim() || DEFAULT_PROTO_PATH);
  if (!existsSync(inventoryProtoPath)) {
    throw new ConfigError(`Inventory protobuf contract not found at ${inventoryProtoPath}`);
  }

  const inventoryRpcDeadlineMs = readInteger(env, 'INVENTORY_RPC_DEADLINE_MS', 800, 1, 120_000);

  return {
    host: env.HOST?.trim() || '0.0.0.0',
    port: readInteger(env, 'PORT', 3000, 1, 65535),
    databaseUrl: readDatabaseUrl(env),
    apiKeyReader,
    apiKeyOperator,
    inventoryGrpcUrl: env.INVENTORY_GRPC_URL?.trim() || 'inventory-grpc:50051',
    inventoryRpcDeadlineMs,
    inventoryProtoPath,
    saga: loadSagaConfig(env, inventoryRpcDeadlineMs),
  };
}

/** Database destination for logs, with credentials removed. */
export function describeDatabase(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  return `${url.hostname}:${url.port || '5432'}${url.pathname}`;
}