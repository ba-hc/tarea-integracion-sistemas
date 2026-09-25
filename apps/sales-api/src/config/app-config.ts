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

  return {
    host: env.HOST?.trim() || '0.0.0.0',
    port: readInteger(env, 'PORT', 3000, 1, 65535),
    databaseUrl: readDatabaseUrl(env),
    apiKeyReader,
    apiKeyOperator,
    inventoryGrpcUrl: env.INVENTORY_GRPC_URL?.trim() || 'inventory-grpc:50051',
    inventoryRpcDeadlineMs: readInteger(env, 'INVENTORY_RPC_DEADLINE_MS', 800, 1, 120_000),
    inventoryProtoPath,
  };
}

/** Database destination for logs, with credentials removed. */
export function describeDatabase(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  return `${url.hostname}:${url.port || '5432'}${url.pathname}`;
}