export class GatewayHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidRequestTargetError extends GatewayHttpError {
  constructor() {
    super(400, 'VALIDATION_ERROR', 'Request validation failed');
  }
}

export class InvalidHeaderError extends GatewayHttpError {
  constructor() {
    super(400, 'VALIDATION_ERROR', 'Request validation failed');
  }
}

export class InvalidBodyError extends GatewayHttpError {
  constructor() {
    super(400, 'VALIDATION_ERROR', 'Request validation failed');
  }
}

export class PayloadTooLargeError extends GatewayHttpError {
  constructor() {
    super(413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds the allowed size', {
      Connection: 'close',
    });
  }
}

export class InvalidTokenError extends GatewayHttpError {
  constructor() {
    super(401, 'UNAUTHORIZED', 'Missing or invalid access token', {
      'WWW-Authenticate': 'Bearer realm="repuestossur"',
    });
  }
}

export class ForbiddenError extends GatewayHttpError {
  constructor() {
    super(403, 'FORBIDDEN', 'The access token does not have permission for this operation');
  }
}

export class RouteNotFoundError extends GatewayHttpError {
  constructor() {
    super(404, 'NOT_FOUND', 'Resource not found');
  }
}

export class MethodNotAllowedError extends GatewayHttpError {
  constructor() {
    super(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  }
}

export class RateLimitError extends GatewayHttpError {
  constructor(retryAfterSeconds: number) {
    super(429, 'RATE_LIMIT_EXCEEDED', 'Rate limit exceeded', {
      'Retry-After': String(Math.max(1, Math.trunc(retryAfterSeconds))),
    });
  }
}

export class UpstreamUnavailableError extends GatewayHttpError {
  constructor() {
    super(503, 'UPSTREAM_UNAVAILABLE', 'Upstream service is unavailable');
  }
}

export class UpstreamTimeoutError extends GatewayHttpError {
  constructor() {
    super(504, 'UPSTREAM_TIMEOUT', 'Upstream service did not respond before the deadline');
  }
}

export class InternalError extends GatewayHttpError {
  constructor() {
    super(500, 'INTERNAL_ERROR', 'An unexpected internal error occurred');
  }
}
