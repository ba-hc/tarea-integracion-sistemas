import { ArgumentsHost, Catch, HttpException, HttpStatus, Logger, type ExceptionFilter } from '@nestjs/common';
import { ApiError } from './api-error.js';

interface TraceRequest {
  traceId?: string;
}

interface HttpResponse {
  status(status: number): HttpResponse;
  json(body: unknown): void;
}

const GENERIC_MESSAGES: Readonly<Record<number, readonly [string, string]>> = {
  [HttpStatus.BAD_REQUEST]: ['VALIDATION_ERROR', 'Request validation failed'],
  [HttpStatus.UNAUTHORIZED]: ['UNAUTHORIZED', 'Missing or invalid API key'],
  [HttpStatus.FORBIDDEN]: ['FORBIDDEN', 'The API key does not have permission for this operation'],
  [HttpStatus.NOT_FOUND]: ['NOT_FOUND', 'Resource not found'],
  [HttpStatus.CONFLICT]: ['CONFLICT', 'The request conflicts with the current resource state'],
};

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<TraceRequest>();
    const response = host.switchToHttp().getResponse<HttpResponse>();
    const traceId = request.traceId ?? 'unknown';

    if (exception instanceof ApiError) {
      const envelope = {
        code: exception.code,
        message: exception.message,
        traceId,
        ...(exception.details === undefined ? {} : { details: exception.details }),
      };
      response.status(exception.getStatus()).json(envelope);
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const [code, message] = GENERIC_MESSAGES[status] ?? ['INTERNAL_ERROR', 'An unexpected internal error occurred'];
      if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
        this.logger.error('request failed', { traceId, status, errorType: exception.name });
      }
      response.status(status).json({ code, message, traceId });
      return;
    }

    this.logger.error('request failed unexpectedly', {
      traceId,
      errorType: exception instanceof Error ? exception.name : 'UnknownError',
    });
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected internal error occurred',
      traceId,
    });
  }
}