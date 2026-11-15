export const GATEWAY_CONFIG = Symbol('GATEWAY_CONFIG');
export const GATEWAY_CLOCK = Symbol('GATEWAY_CLOCK');
export const GATEWAY_LOGGER = Symbol('GATEWAY_LOGGER');

export type Role = 'reader' | 'operator';

export interface JwtConfig {
  readonly secret: string;
  readonly issuer: string;
  readonly audience: string;
}

export interface GatewayConfig extends JwtConfig {
  readonly host: string;
  readonly port: number;
  readonly salesBaseUrl: string;
  readonly bffBaseUrl: string;
  readonly salesApiKeyReader: string;
  readonly salesApiKeyOperator: string;
  readonly salesTimeoutMs: number;
  readonly bffTimeoutMs: number;
  readonly rateLimitWindowMs: number;
  readonly rateLimitMaxRequests: number;
  readonly rateLimitMaxIdentities: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
}

export class ConfigError extends Error {}

const DEFAULT_ISSUER = 'repuestossur-demo';
const DEFAULT_AUDIENCE = 'repuestossur-gateway';
const MAX_TIMER_MS = 2_147_483_647;

function requiredTrimmed(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(`${name} is required`);
  return value;
}

function trimmedWithDefault(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = raw.trim();
  if (!value) throw new ConfigError(`${name} must not be empty`);
  return value;
}

function readInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  if (!/^[0-9]+$/.test(raw)) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function readHttpBaseUrl(env: NodeJS.ProcessEnv, name: string): string {
  const raw = requiredTrimmed(env, name);
  if (raw.includes('?') || raw.includes('#')) {
    throw new ConfigError(`${name} must be an HTTP(S) URL without query or fragment`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${name} must be a valid HTTP(S) URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`${name} must use http:// or https://`);
  }
  if (url.username || url.password) {
    throw new ConfigError(`${name} must not contain userinfo`);
  }
  if (!url.hostname) {
    throw new ConfigError(`${name} must include a host`);
  }
  return raw.replace(/\/+$/, '');
}

export function loadJwtConfig(env: NodeJS.ProcessEnv = process.env): JwtConfig {
  const secret = env.GATEWAY_JWT_SECRET;
  if (typeof secret !== 'string' || secret.length === 0 || secret.trim().length === 0) {
    throw new ConfigError('GATEWAY_JWT_SECRET is required');
  }
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new ConfigError('GATEWAY_JWT_SECRET must be at least 32 bytes');
  }
  return {
    secret,
    issuer: trimmedWithDefault(env, 'GATEWAY_JWT_ISSUER', DEFAULT_ISSUER),
    audience: trimmedWithDefault(env, 'GATEWAY_JWT_AUDIENCE', DEFAULT_AUDIENCE),
  };
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED?.trim() === '0') {
    throw new ConfigError('NODE_TLS_REJECT_UNAUTHORIZED=0 is not allowed');
  }

  const jwt = loadJwtConfig(env);
  const salesApiKeyReader = requiredTrimmed(env, 'GATEWAY_SALES_API_KEY_READER');
  const salesApiKeyOperator = requiredTrimmed(env, 'GATEWAY_SALES_API_KEY_OPERATOR');
  if (salesApiKeyReader === salesApiKeyOperator) {
    throw new ConfigError('GATEWAY_SALES_API_KEY_READER and GATEWAY_SALES_API_KEY_OPERATOR must be different');
  }

  return {
    ...jwt,
    host: trimmedWithDefault(env, 'GATEWAY_HOST', '0.0.0.0'),
    port: readInteger(env, 'GATEWAY_PORT', 8080, 1, 65_535),
    salesBaseUrl: readHttpBaseUrl(env, 'GATEWAY_SALES_BASE_URL'),
    bffBaseUrl: readHttpBaseUrl(env, 'GATEWAY_BFF_BASE_URL'),
    salesApiKeyReader,
    salesApiKeyOperator,
    salesTimeoutMs: readInteger(env, 'GATEWAY_SALES_TIMEOUT_MS', 10_000, 1, MAX_TIMER_MS),
    bffTimeoutMs: readInteger(env, 'GATEWAY_BFF_TIMEOUT_MS', 2_500, 1, MAX_TIMER_MS),
    rateLimitWindowMs: readInteger(env, 'GATEWAY_RATE_LIMIT_WINDOW_MS', 60_000, 1, MAX_TIMER_MS),
    rateLimitMaxRequests: readInteger(
      env,
      'GATEWAY_RATE_LIMIT_MAX_REQUESTS',
      60,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    rateLimitMaxIdentities: readInteger(
      env,
      'GATEWAY_RATE_LIMIT_MAX_IDENTITIES',
      10_000,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    maxRequestBytes: readInteger(
      env,
      'GATEWAY_MAX_REQUEST_BODY_BYTES',
      1_048_576,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    maxResponseBytes: readInteger(
      env,
      'GATEWAY_MAX_RESPONSE_BODY_BYTES',
      2_097_152,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}
