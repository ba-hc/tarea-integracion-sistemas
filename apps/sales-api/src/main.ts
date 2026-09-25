import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Logger, ValidationPipe } from '@nestjs/common';
import type { ValidationError } from 'class-validator';
import { NestFactory } from '@nestjs/core';
import { ApiError } from './common/api-error.js';
import { ApiExceptionFilter } from './common/api-exception.filter.js';
import { AppModule } from './app.module.js';
import { ConfigError, describeDatabase, loadSalesConfig } from './config/app-config.js';

interface TraceRequest {
  method: string;
  baseUrl?: string;
  route?: { path?: string };
  traceId?: string;
  authRole?: 'reader' | 'operator';
}
interface TraceResponse {
  setHeader(name: string, value: string): void;
  on(event: 'finish', listener: () => void): void;
  statusCode: number;
}
function validationDetails(errors: ValidationError[]): Array<{ field: string; reason: string }> {
  const result: Array<{ field: string; reason: string }> = [];
  const visit = (items: ValidationError[], parent: string): void => {
    for (const error of items) {
      const field = parent ? `${parent}.${error.property}` : error.property;
      for (const reason of Object.values(error.constraints ?? {})) result.push({ field, reason });
      if (error.children?.length) visit(error.children, field);
    }
  };
  visit(errors, '');
  return result;
}

async function bootstrap(): Promise<void> {
  let config;
  try {
    config = loadSalesConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      new Logger('Bootstrap').error(`invalid configuration: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  const app = await NestFactory.create(AppModule.register(config));
  app.enableShutdownHooks();
  app.use((request: TraceRequest, response: TraceResponse, next: () => void) => {
    const traceId = randomUUID();
    const startedAt = performance.now();
    request.traceId = traceId;
    response.setHeader('X-Trace-Id', traceId);
    response.on('finish', () => {
      const logger = new Logger('HttpRequest');
      logger.log('request completed', {
        method: request.method,
        route: request.route?.path ?? request.baseUrl ?? 'unmatched',
        role: request.authRole ?? 'anonymous',
        status: response.statusCode,
        durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
        traceId,
      });
    });
    next();
  });
  app.useGlobalPipes(new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    exceptionFactory: (errors) => new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed', {
      fieldErrors: validationDetails(errors),
    }),
  }));
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.listen(config.port, config.host);
  new Logger('Bootstrap').log('sales api listening', {
    address: `${config.host}:${config.port}`,
    database: describeDatabase(config.databaseUrl),
    inventory: config.inventoryGrpcUrl,
    inventoryDeadlineMs: config.inventoryRpcDeadlineMs,
  });
}

await bootstrap();