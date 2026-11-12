import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DispatchController } from './dispatch.controller.js';
import { DispatchService } from './dispatch.service.js';
import { DispatchExceptionFilter, traceRequest } from './http.js';

@Module({ controllers: [DispatchController], providers: [DispatchService] })
class DispatchModule {}

const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be a valid TCP port');
const failCreate = process.env.DISPATCH_FAIL_CREATE;
if (failCreate !== undefined && failCreate !== 'true' && failCreate !== 'false') {
  throw new Error('DISPATCH_FAIL_CREATE must be true or false');
}

const app = await NestFactory.create(DispatchModule);
app.enableShutdownHooks();
app.use(traceRequest);
app.useGlobalFilters(new DispatchExceptionFilter());
await app.listen(port, process.env.HOST ?? '0.0.0.0');
