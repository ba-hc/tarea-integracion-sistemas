import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { ConfigError, loadConfig } from './config/app-config.js';
import { grpcServerOptions } from './grpc/grpc-server-options.js';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      logger.error(`configuración inválida: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  const app = await NestFactory.createMicroservice(AppModule.register(config), grpcServerOptions(config));
  // SIGTERM/SIGINT (p. ej. `docker compose stop`) cierran el servidor gRPC y
  // el pool de Prisma de forma ordenada.
  app.enableShutdownHooks();
  await app.listen();
  logger.log(`Inventory gRPC escuchando en ${config.grpcHost}:${config.grpcPort}`);
}

await bootstrap();
