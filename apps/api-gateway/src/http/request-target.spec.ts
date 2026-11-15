import { describe, expect, it } from 'vitest';
import { parseRequestTarget } from './request-target.js';
import { matchRoute, ROUTES } from './route.js';

describe('request target parsing', () => {
  it('preserves the path and raw query', () => {
    expect(parseRequestTarget('/v1/orders?page=1&status=CONFIRMED&status=CANCELLED')).toEqual({
      path: '/v1/orders',
      query: 'page=1&status=CONFIRMED&status=CANCELLED',
    });
  });

  it('allows encoded slashes in the query but not in the path', () => {
    expect(parseRequestTarget('/v1/orders?next=%2Fv1%2Forders')).toEqual({
      path: '/v1/orders',
      query: 'next=%2Fv1%2Forders',
    });
    expect(() => parseRequestTarget('/v1/orders%2F1')).toThrowError();
  });

  it.each([
    'http://example.com/v1/orders',
    '//example.com/v1/orders',
    '*',
    '/v1/../orders',
    '/v1/%2e%2e/orders',
    '/v1\\orders',
    '/v1/orders/',
    '/v1//orders',
    '/v1/orders#fragment',
    '',
  ])('rejects ambiguous target %s', (target) => {
    expect(() => parseRequestTarget(target)).toThrowError();
  });

  it('matches all documented routes and methods', () => {
    expect(ROUTES).toHaveLength(10);
    const cases: Array<[string, string]> = [
      ['GET', '/health'],
      ['GET', '/v1/health'],
      ['POST', '/v1/customers'],
      ['GET', '/v1/customers'],
      ['GET', '/v1/customers/4f4c2c1e-6d7a-4f5e-9d5e-0f6a7b8c9d0e'],
      ['POST', '/v1/orders'],
      ['GET', '/v1/orders'],
      ['GET', '/v1/orders/4f4c2c1e-6d7a-4f5e-9d5e-0f6a7b8c9d0e'],
      ['POST', '/v1/orders/4f4c2c1e-6d7a-4f5e-9d5e-0f6a7b8c9d0e/cancel'],
      ['GET', '/web/v1/orders/4f4c2c1e-6d7a-4f5e-9d5e-0f6a7b8c9d0e/summary'],
    ];
    for (const [method, path] of cases) {
      expect(matchRoute(method, path).route?.template).toBeDefined();
    }
  });

  it('distinguishes unknown paths from known paths with a wrong method', () => {
    expect(matchRoute('GET', '/internal/v1/dispatches/x')).toEqual({ pathMatched: false });
    expect(matchRoute('POST', '/v1/health')).toEqual({ pathMatched: true });
    expect(matchRoute('DELETE', '/v1/orders')).toEqual({ pathMatched: true });
  });
});
