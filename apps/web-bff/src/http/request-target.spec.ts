import { describe, expect, it } from 'vitest';
import { parseTarget } from './request-target.js';
import { matchRoute, ROUTES } from './route.js';

describe('BFF request targets', () => {
  it('parses health and summary paths while preserving query', () => {
    expect(parseTarget('/health')).toEqual({ path: '/health', query: '' });
    expect(parseTarget('/web/v1/orders/abc/summary?x=1')).toEqual({
      path: '/web/v1/orders/abc/summary',
      query: 'x=1',
    });
  });

  it.each([
    'http://example.com/health',
    '//example.com/health',
    '*',
    '/health/',
    '/health//',
    '/health/../summary',
    '/web/v1/orders/%2e%2e/summary',
    '/web/v1/orders/a%2fb/summary',
    '/web/v1/orders/a\\b/summary',
    '/health#fragment',
    '',
  ])('rejects ambiguous target %s', (target) => {
    expect(() => parseTarget(target)).toThrowError();
  });

  it('matches only the documented GET routes', () => {
    expect(ROUTES).toHaveLength(2);
    expect(matchRoute('GET', '/health').route?.template).toBe('/health');
    expect(matchRoute('GET', '/web/v1/orders/abc/summary')).toMatchObject({
      pathMatched: true,
      orderId: 'abc',
      template: '/web/v1/orders/:orderId/summary',
    });
    expect(matchRoute('GET', '/internal/v1/payments/abc')).toEqual({ pathMatched: false });
    expect(matchRoute('POST', '/health')).toEqual({ pathMatched: true, template: '/health' });
    expect(matchRoute('POST', '/web/v1/orders/abc/summary')).toMatchObject({
      pathMatched: true,
      template: '/web/v1/orders/:orderId/summary',
    });
    expect(matchRoute('GET', '/web/v1/orders/abc/summary/extra')).toEqual({ pathMatched: false });
  });
});
