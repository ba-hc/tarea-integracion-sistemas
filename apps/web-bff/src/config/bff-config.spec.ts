import { describe, expect, it } from 'vitest';
import { ConfigError, loadBffConfig } from './bff-config.js';

const BASE_ENV: NodeJS.ProcessEnv = {
  BFF_PAYMENTS_BASE_URL: 'http://payments-api:3003',
  BFF_DISPATCH_BASE_URL: 'http://dispatch-api:3001',
};

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...BASE_ENV, ...overrides };
}

describe('BFF configuration', () => {
  it('loads the documented defaults', () => {
    const config = loadBffConfig(env());
    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(3002);
    expect(config.sourceTimeoutMs).toBe(1_500);
    expect(config.maxResponseBytes).toBe(2_097_152);
  });

  it('requires both source URLs', () => {
    expect(() => loadBffConfig(env({ BFF_PAYMENTS_BASE_URL: undefined }))).toThrowError(ConfigError);
    expect(() => loadBffConfig(env({ BFF_DISPATCH_BASE_URL: undefined }))).toThrowError(ConfigError);
  });

  it.each([
    ['ftp://payments:3003', 'http://'],
    ['http://user:pass@payments:3003', 'userinfo'],
    ['http://payments:3003?x=1', 'query or fragment'],
    ['http://payments:3003#x', 'query or fragment'],
    ['not a url', 'valid HTTP(S) URL'],
  ])('rejects invalid source URL %s', (url, message) => {
    expect(() => loadBffConfig(env({ BFF_PAYMENTS_BASE_URL: url }))).toThrowError(message);
  });

  it('does not echo URL values in errors', () => {
    try {
      loadBffConfig(env({ BFF_PAYMENTS_BASE_URL: 'http://user:pass@payments:3003' }));
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).not.toContain('user:pass');
      expect((error as Error).message).not.toContain('payments:3003');
    }
  });

  it('validates ports, timeouts and body limits as safe integers', () => {
    expect(() => loadBffConfig(env({ BFF_PORT: '0' }))).toThrowError(ConfigError);
    expect(() => loadBffConfig(env({ BFF_PORT: '65536' }))).toThrowError(ConfigError);
    expect(() => loadBffConfig(env({ BFF_SOURCE_TIMEOUT_MS: '2147483648' }))).toThrowError(ConfigError);
    expect(() => loadBffConfig(env({ BFF_MAX_RESPONSE_BODY_BYTES: '1.5' }))).toThrowError(ConfigError);
    expect(() => loadBffConfig(env({ BFF_MAX_RESPONSE_BODY_BYTES: '0' }))).toThrowError(ConfigError);
  });

  it('rejects disabled TLS verification', () => {
    expect(() => loadBffConfig(env({ NODE_TLS_REJECT_UNAUTHORIZED: '0' }))).toThrowError(
      'NODE_TLS_REJECT_UNAUTHORIZED=0 is not allowed',
    );
  });
});
