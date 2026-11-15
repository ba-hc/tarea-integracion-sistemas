export class BffHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends BffHttpError {
  constructor() {
    super(400, 'VALIDATION_ERROR', 'Request validation failed');
  }
}

export class RouteNotFoundError extends BffHttpError {
  constructor() {
    super(404, 'NOT_FOUND', 'Resource not found');
  }
}

export class MethodNotAllowedError extends BffHttpError {
  constructor() {
    super(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  }
}

export class InternalError extends BffHttpError {
  constructor() {
    super(500, 'INTERNAL_ERROR', 'An unexpected internal error occurred');
  }
}
