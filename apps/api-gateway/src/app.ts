import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { GatewayConfig } from './config/gateway-config.js';
import { GatewayModule, type GatewayOverrides } from './gateway.module.js';
import { GatewayService } from './gateway.service.js';

export async function createGatewayApp(
  config: GatewayConfig,
  overrides: GatewayOverrides = {},
): Promise<INestApplication> {
  const app = await NestFactory.create(GatewayModule.register(config, overrides), {
    bodyParser: false,
    logger: false,
  });
  const gateway = app.get(GatewayService);
  app.use(gateway.handle);
  return app;
}
