export class ConfigError extends Error {}

export interface CircuitBreakerConfig {
  readonly enabled: boolean;
  /** Últimas llamadas que se consideran para calcular la tasa de fallas. */
  readonly windowSize: number;
  /** Llamadas mínimas en la ventana antes de poder abrir el circuito. */
  readonly minimumCalls: number;
  /** Porcentaje de fallas (1-100) que abre el circuito. */
  readonly failureRateThreshold: number;
  /** Tiempo que el circuito permanece abierto antes de dejar pasar sondas. */
  readonly openMs: number;
  /** Sondas permitidas en semiabierto; todas deben salir bien para cerrar. */
  readonly halfOpenMaxCalls: number;
}

export interface PaymentsConfig {
  readonly host: string;
  readonly port: number;
  readonly databaseUrl: string;
  readonly gateway: { readonly baseUrl: string; readonly timeoutMs: number };
  readonly circuitBreaker: CircuitBreakerConfig;
  readonly bulkhead: { readonly enabled: boolean; readonly maxConcurrent: number };
  /** 0 desactiva el reconciliador de cobros inciertos. */
  readonly reconcileIntervalMs: number;
}

type Env = Record<string, string | undefined>;

function integer(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

function flag(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw !== 'true' && raw !== 'false') throw new ConfigError(`${name} must be true or false`);
  return raw === 'true';
}

function httpUrl(env: Env, name: string, fallback: string): string {
  const raw = env[name] || fallback;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${name} must be an http(s) URL`);
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.search || url.hash || url.username || url.password) {
    throw new ConfigError(`${name} must be an http(s) URL without credentials, query or fragment`);
  }
  return raw.replace(/\/+$/, '');
}

export function loadConfig(env: Env = process.env): PaymentsConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new ConfigError('DATABASE_URL is required');

  const circuitBreaker: CircuitBreakerConfig = {
    enabled: flag(env, 'PAYMENTS_CIRCUIT_BREAKER_ENABLED', true),
    windowSize: integer(env, 'PAYMENTS_CB_WINDOW_SIZE', 10, 1, 1_000),
    minimumCalls: integer(env, 'PAYMENTS_CB_MINIMUM_CALLS', 5, 1, 1_000),
    failureRateThreshold: integer(env, 'PAYMENTS_CB_FAILURE_RATE_THRESHOLD', 50, 1, 100),
    openMs: integer(env, 'PAYMENTS_CB_OPEN_MS', 5_000, 100, 600_000),
    halfOpenMaxCalls: integer(env, 'PAYMENTS_CB_HALF_OPEN_MAX_CALLS', 1, 1, 100),
  };
  if (circuitBreaker.minimumCalls > circuitBreaker.windowSize) {
    throw new ConfigError('PAYMENTS_CB_MINIMUM_CALLS cannot exceed PAYMENTS_CB_WINDOW_SIZE');
  }

  return {
    host: env.HOST || '0.0.0.0',
    port: integer(env, 'PORT', 3003, 1, 65_535),
    databaseUrl,
    gateway: {
      baseUrl: httpUrl(env, 'PAYMENT_GATEWAY_URL', 'http://payment-gateway-sim:3010'),
      timeoutMs: integer(env, 'PAYMENTS_GATEWAY_TIMEOUT_MS', 1_200, 10, 120_000),
    },
    circuitBreaker,
    bulkhead: {
      enabled: flag(env, 'PAYMENTS_BULKHEAD_ENABLED', true),
      maxConcurrent: integer(env, 'PAYMENTS_BULKHEAD_MAX_CONCURRENT', 8, 1, 10_000),
    },
    reconcileIntervalMs: integer(env, 'PAYMENTS_RECONCILE_INTERVAL_MS', 5_000, 0, 3_600_000),
  };
}
