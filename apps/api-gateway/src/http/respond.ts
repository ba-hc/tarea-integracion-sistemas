import type { ServerResponse } from 'node:http';
import type { ProxyResult } from '../proxy/proxy-client.js';
import type { GatewayHttpError } from './errors.js';

function writeHeaders(response: ServerResponse, headers: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
}

export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  traceId: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('X-Trace-Id', traceId);
  writeHeaders(response, extraHeaders);
  response.end(JSON.stringify(body));
}

export function sendError(response: ServerResponse, error: GatewayHttpError, traceId: string): void {
  sendJson(
    response,
    error.status,
    { code: error.code, message: error.message, traceId },
    traceId,
    error.headers,
  );
}

export function sendProxyResult(response: ServerResponse, result: ProxyResult): void {
  response.statusCode = result.status;
  if (result.contentType !== undefined) response.setHeader('Content-Type', result.contentType);
  if (result.location !== undefined) response.setHeader('Location', result.location);
  if (result.idempotencyReplayed !== undefined) {
    response.setHeader('Idempotency-Replayed', result.idempotencyReplayed);
  }
  if (result.traceId !== undefined) response.setHeader('X-Trace-Id', result.traceId);
  response.end(result.body);
}
