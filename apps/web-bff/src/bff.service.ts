import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Inject, Injectable } from '@nestjs/common';
import { BFF_LOGGER } from './config/bff-config.js';
import {
  BffHttpError,
  InternalError,
  MethodNotAllowedError,
  RouteNotFoundError,
  ValidationError,
} from './http/errors.js';
import { hasRequestBody, rawHeaderValues } from './http/headers.js';
import { parseTarget } from './http/request-target.js';
import { sendError, sendJson } from './http/respond.js';
import { matchRoute } from './http/route.js';
import { isUuid } from './http/uuid.js';
import { type BffLoggerPort, type BffLogRecord } from './logging/bff-logger.js';
import type { SourceAvailability } from './sources/types.js';
import { SummaryService } from './summary/summary.service.js';

function chooseTrace(request: IncomingMessage): string {
  const values = rawHeaderValues(request, 'x-trace-id');
  if (values.length === 1 && isUuid(values[0])) return values[0];
  return randomUUID();
}

@Injectable()
export class BffService {
  constructor(
    private readonly summary: SummaryService,
    @Inject(BFF_LOGGER) private readonly logger: BffLoggerPort,
  ) {}

  handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const startedAt = Date.now();
    const traceId = chooseTrace(request);
    let route = 'unmatched';
    let status = 500;
    let sources: { payment: SourceAvailability; dispatch: SourceAvailability } | undefined;
    let errorCode: string | undefined;

    try {
      const target = parseTarget(request.url);
      if (request.method === 'GET' && hasRequestBody(request)) throw new ValidationError();

      const match = matchRoute(request.method ?? '', target.path);
      if (!match.pathMatched) throw new RouteNotFoundError();
      route = match.template ?? 'unmatched';
      if (match.route === undefined) throw new MethodNotAllowedError();

      if (match.route.template === '/health') {
        status = 200;
        sendJson(response, 200, { status: 'ok', service: 'web-bff' }, traceId);
        return;
      }

      const rawOrderId = match.orderId;
      if (rawOrderId === undefined || !isUuid(rawOrderId)) throw new ValidationError();
      const orderId = rawOrderId.toLowerCase();

      const outcome = await this.summary.summarize(orderId, traceId);
      if (outcome.kind === 'success') {
        status = 200;
        sources = {
          payment: outcome.body.payment.availability,
          dispatch: outcome.body.dispatch.availability,
        };
        sendJson(response, 200, outcome.body, traceId);
        return;
      }

      status = outcome.error.status;
      errorCode = outcome.error.code;
      sources = outcome.error.details?.sources
        ?? (outcome.error.code === 'SUMMARY_NOT_FOUND'
          ? { payment: 'not_found', dispatch: 'not_found' }
          : undefined);
      const details = outcome.error.details === undefined
        ? undefined
        : { sources: outcome.error.details.sources };
      throw new BffHttpError(
        outcome.error.status,
        outcome.error.code,
        outcome.error.message,
        details,
      );
    } catch (error) {
      const httpError = error instanceof BffHttpError ? error : new InternalError();
      status = httpError.status;
      errorCode = httpError.code;
      try {
        if (!response.headersSent && hasRequestBody(request)) {
          response.setHeader('Connection', 'close');
        }
        sendError(response, httpError, traceId);
      } catch {
        // The client may have disconnected; never surface the internal error.
      }
    } finally {
      const record: BffLogRecord = {
        traceId,
        route,
        status,
        durationMs: Math.max(0, Date.now() - startedAt),
        ...(sources === undefined ? {} : { payment: sources.payment, dispatch: sources.dispatch }),
        ...(errorCode === undefined ? {} : { errorCode }),
      };
      try {
        this.logger.log(record);
      } catch {
        // Logging must not change the response or expose internals.
      }
    }
  };
}
