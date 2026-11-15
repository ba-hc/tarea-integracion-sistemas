import type { ServerResponse } from 'node:http';
import type { BffHttpError } from './errors.js';

export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  traceId: string,
): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('X-Trace-Id', traceId);
  response.end(JSON.stringify(body));
}

export function sendError(response: ServerResponse, error: BffHttpError, traceId: string): void {
  sendJson(
    response,
    error.status,
    {
      code: error.code,
      message: error.message,
      traceId,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
    traceId,
  );
}
