import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  loadGatewayConfig,
  loadJwtConfig,
} from './gateway-config.js';

const BASE_ENV: NodeJS.ProcessEnv = {
  GATEWAY_SALES_BASE_URL: 'http://sales-api:3000',
  GATEWAY_BFF_BASE_URL: 'http://web-bff:3002',
  GATEWAY_JWT_SECRET: 'test-secret-with-at-least-32-bytes!!',
  GATEWAY_SALES_API_KEY_READER: 'reader-internal',
  GATEWAY_SALES_API_KEY_OPERATOR: 'operator-internal',
};

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...BASE_ENV, ...overrides };
}

describe('gateway configuration', () => {
  it('loads the documented defaults', () => {
    const config = loadGatewayConfig(env());
    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(8080);
    expect(config.issuer).toBe('repuestossur-demo');
    expect(config.audience).toBe('repuestossur-gateway');
    expect(config.salesTimeoutMs).toBe(10_000);
    expect(config.bffTimeoutMs).toBe(2_500);
    expect(config.rateLimitWindowMs).toBe(60_000);
    expect(config.rateLimitMaxRequests).toBe(60);
    expect(config.rateLimitMaxIdentities).toBe(10_000);
    expect(config.maxRequestBytes).toBe(1_048_576);
    expect(config.maxResponseBytes).toBe(2_097_152);
  });

  it('requires a strong JWT secret and never includes its value in errors', () => {
    expect(() => loadGatewayConfig(env({ GATEWAY_JWT_SECRET: undefined }))).toThrowError(ConfigError);
    expect(() => loadGatewayConfig(env({ GATEWAY_JWT_SECRET: 'short' }))).toThrowError(
      'GATEWAY_JWT_SECRET must be at least 32 bytes',
    );
    expect(() => loadGatewayConfig(env({ GATEWAY_JWT_SECRET: ' '.repeat(32) }))).toThrowError(
      'GATEWAY_JWT_SECRET is required',
    );
  });

  it('requires distinct internal keys', () => {
    expect(() => loadGatewayConfig(env({ GATEWAY_SALES_API_KEY_OPERATOR: 'reader-internal' }))).toThrowError(
      'GATEWAY_SALES_API_KEY_READER and GATEWAY_SALES_API_KEY_OPERATOR must be different',
    );
  });

  it.each([
    ['ftp://sales:3000', 'http://'],
    ['http://user:pass@sales:3000', 'userinfo'],
    ['http://sales:3000?x=1', 'query or fragment'],
    ['http://sales:3000#x', 'query or fragment'],
    ['not a url', 'valid HTTP(S) URL'],
  ])('rejects invalid Sales base URL %s', (url, message) => {
    expect(() => loadGatewayConfig(env({ GATEWAY_SALES_BASE_URL: url }))).toThrowError(message);
  });

  it('validates ports, timeouts and body limits as safe integers', () => {
    expect(() => loadGatewayConfig(env({ GATEWAY_PORT: '0' }))).toThrowError(ConfigError);
    expect(() => loadGatewayConfig(env({ GATEWAY_PORT: '65536' }))).toThrowError(ConfigError);
    expect(() => loadGatewayConfig(env({ GATEWAY_SALES_TIMEOUT_MS: '2147483648' }))).toThrowError(
      ConfigError,
    );
    expect(() => loadGatewayConfig(env({ GATEWAY_MAX_REQUEST_BODY_BYTES: '1.5' }))).toThrowError(
      ConfigError,
    );
    expect(() => loadGatewayConfig(env({ GATEWAY_RATE_LIMIT_MAX_REQUESTS: '0' }))).toThrowError(
      ConfigError,
    );
  });

  it('rejects disabled TLS verification', () => {
    expect(() => loadGatewayConfig(env({ NODE_TLS_REJECT_UNAUTHORIZED: '0' }))).toThrowError(
      'NODE_TLS_REJECT_UNAUTHORIZED=0 is not allowed',
    );
  });

  it('loads JWT-only configuration for the CLI without Sales settings', () => {
    const config = loadJwtConfig({ GATEWAY_JWT_SECRET: 'x'.repeat(32) });
    expect(config).toEqual({
      secret: 'x'.repeat(32),
      issuer: 'repuestossur-demo',
      audience: 'repuestossur-gateway',
    });
  });
});
