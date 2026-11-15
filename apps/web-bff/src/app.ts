import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { BffService } from './bff.service.js';
import { BffModule, type BffOverrides } from './bff.module.js';
import type { BffConfig } from './config/bff-config.js';

export async function createBffApp(
  config: BffConfig,
  overrides: BffOverrides = {},
): Promise<INestApplication> {
  const app = await NestFactory.create(BffModule.register(config, overrides), {
    bodyParser: false,
    logger: false,
  });
  const bff = app.get(BffService);
  app.use(bff.handle);

  const instance = app.getHttpAdapter().getInstance() as { disable?: (name: string) => void };
  instance.disable?.('x-powered-by');
  return app;
}
