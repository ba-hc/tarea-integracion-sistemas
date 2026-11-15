export interface BffRoute {
  readonly method: 'GET';
  readonly pattern: RegExp;
  readonly template: string;
}

export const ROUTES: readonly BffRoute[] = [
  {
    method: 'GET',
    pattern: /^\/health$/,
    template: '/health',
  },
  {
    method: 'GET',
    pattern: /^\/web\/v1\/orders\/[^/]+\/summary$/,
    template: '/web/v1/orders/:orderId/summary',
  },
];

export interface RouteMatch {
  readonly pathMatched: boolean;
  readonly route?: BffRoute;
  readonly template?: string;
  readonly orderId?: string;
}

const SUMMARY_PATTERN = /^\/web\/v1\/orders\/([^/]+)\/summary$/;

export function matchRoute(method: string, path: string): RouteMatch {
  const candidates = ROUTES.filter((route) => route.pattern.test(path));
  const first = candidates[0];
  if (first === undefined) return { pathMatched: false };

  const route = candidates.find((candidate) => candidate.method === method);
  if (route === undefined) return { pathMatched: true, template: first.template };

  if (route.template === '/web/v1/orders/:orderId/summary') {
    const orderId = SUMMARY_PATTERN.exec(path)?.[1];
    return orderId === undefined
      ? { pathMatched: true, route, template: route.template }
      : { pathMatched: true, route, template: route.template, orderId };
  }

  return { pathMatched: true, route, template: route.template };
}
