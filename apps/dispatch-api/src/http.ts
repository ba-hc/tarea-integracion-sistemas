import { randomUUID } from 'node:crypto';
import { Catch, HttpException, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export class DispatchError extends HttpException {
  constructor(status: number, readonly code: string, message: string) {
    super(message, status);
  }
}

export interface TraceRequest {
  headers: Record<string, string | string[] | undefined>;
  traceId?: string;
}

export interface HttpResponse {
  setHeader(name: string, value: string): void;
  status(code: number): HttpResponse;
  json(body: unknown): void;
}

export function traceRequest(request: TraceRequest, response: HttpResponse, next: () => void): void {
  const incomingTraceId = request.headers['x-trace-id'];
  request.traceId = isUuid(incomingTraceId) ? incomingTraceId : randomUUID();
  response.setHeader('X-Trace-Id', request.traceId);
  next();
}

@Catch()
export class DispatchExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DispatchExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const traceId = http.getRequest<TraceRequest>().traceId ?? randomUUID();
    const response = http.getResponse<HttpResponse>();
    response.setHeader('X-Trace-Id', traceId);

    if (exception instanceof DispatchError) {
      if (exception.getStatus() >= 500) {
        this.logger.warn(`${exception.code} traceId=${traceId}`);
      }
      response.status(exception.getStatus()).json({ code: exception.code, message: exception.message, traceId });
      return;
    }

    if (exception instanceof HttpException && exception.getStatus() < 500) {
      const status = exception.getStatus();
      const code = status === 400 ? 'VALIDATION_ERROR' : status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR';
      const message = status === 400 ? 'Request validation failed' : status === 404 ? 'Resource not found' : 'Request failed';
      response.status(status).json({ code, message, traceId });
      return;
    }

    this.logger.error(`request failed traceId=${traceId} type=${exception instanceof Error ? exception.name : 'UnknownError'}`);
    response.status(500).json({ code: 'INTERNAL_ERROR', message: 'An unexpected internal error occurred', traceId });
  }
}
