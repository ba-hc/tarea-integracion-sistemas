export type RouteTarget = 'local' | 'sales' | 'bff';
export type RouteRole = 'public' | 'reader' | 'operator';
export type RouteBody = 'none' | 'json';

export interface GatewayRoute {
  readonly method: 'GET' | 'POST';
  readonly pattern: RegExp;
  readonly template: string;
  readonly target: RouteTarget;
  /** `reader` means both reader and operator; `operator` means operator only. */
  readonly role: RouteRole;
  readonly body: RouteBody;
}

export const ROUTES: readonly GatewayRoute[] = [
  {
    method: 'GET',
    pattern: /^\/health$/,
    template: '/health',
    target: 'local',
    role: 'public',
    body: 'none',
  },
  {
    method: 'GET',
    pattern: /^\/v1\/health$/,
    template: '/v1/health',
    target: 'sales',
    role: 'public',
    body: 'none',
  },
  {
    method: 'POST',
    pattern: /^\/v1\/customers$/,
    template: '/v1/customers',
    target: 'sales',
    role: 'operator',
    body: 'json',
  },
  {
    method: 'GET',
    pattern: /^\/v1\/customers$/,
    template: '/v1/customers',
    target: 'sales',
    role: 'reader',
    body: 'none',
  },
  {
    method: 'GET',
    pattern: /^\/v1\/customers\/[^/]+$/,
    template: '/v1/customers/:customerId',
    target: 'sales',
    role: 'reader',
    body: 'none',
  },
  {
    method: 'POST',
    pattern: /^\/v1\/orders$/,
    template: '/v1/orders',
    target: 'sales',
    role: 'operator',
    body: 'json',
  },
  {
    method: 'GET',
    pattern: /^\/v1\/orders$/,
    template: '/v1/orders',
    target: 'sales',
    role: 'reader',
    body: 'none',
  },
  {
    method: 'GET',
    pattern: /^\/v1\/orders\/[^/]+$/,
    template: '/v1/orders/:orderId',
    target: 'sales',
    role: 'reader',
    body: 'none',
  },
  {
    method: 'POST',
    pattern: /^\/v1\/orders\/[^/]+\/cancel$/,
    template: '/v1/orders/:orderId/cancel',
    target: 'sales',
    role: 'operator',
    body: 'none',
  },
  {
    method: 'GET',
    pattern: /^\/web\/v1\/orders\/[^/]+\/summary$/,
    template: '/web/v1/orders/:orderId/summary',
    target: 'bff',
    role: 'reader',
    body: 'none',
  },
];

export interface RouteMatch {
  readonly pathMatched: boolean;
  readonly route?: GatewayRoute;
}

export function matchRoute(method: string, path: string): RouteMatch {
  const pathRoutes = ROUTES.filter((route) => route.pattern.test(path));
  if (pathRoutes.length === 0) return { pathMatched: false };
  const route = pathRoutes.find((candidate) => candidate.method === method);
  return route ? { pathMatched: true, route } : { pathMatched: true };
}
