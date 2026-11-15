export const BFF_CONFIG = Symbol('BFF_CONFIG');
export const BFF_LOGGER = Symbol('BFF_LOGGER');

export interface BffConfig {
  readonly host: string;
  readonly port: number;
  readonly paymentsBaseUrl: string;
  readonly dispatchBaseUrl: string;
  readonly sourceTimeoutMs: number;
  readonly maxResponseBytes: number;
}

export class ConfigError extends Error {}

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

export function loadBffConfig(env: NodeJS.ProcessEnv = process.env): BffConfig {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED?.trim() === '0') {
    throw new ConfigError('NODE_TLS_REJECT_UNAUTHORIZED=0 is not allowed');
  }

  return {
    host: trimmedWithDefault(env, 'BFF_HOST', '0.0.0.0'),
    port: readInteger(env, 'BFF_PORT', 3002, 1, 65_535),
    paymentsBaseUrl: readHttpBaseUrl(env, 'BFF_PAYMENTS_BASE_URL'),
    dispatchBaseUrl: readHttpBaseUrl(env, 'BFF_DISPATCH_BASE_URL'),
    sourceTimeoutMs: readInteger(env, 'BFF_SOURCE_TIMEOUT_MS', 1_500, 1, MAX_TIMER_MS),
    maxResponseBytes: readInteger(
      env,
      'BFF_MAX_RESPONSE_BODY_BYTES',
      2_097_152,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}
