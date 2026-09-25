import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { ConfigError, describeDatabase, loadConfig, type AppConfig } from './config/app-config.js';
import { grpcServerOptions } from './grpc/grpc-server-options.js';
import { createHealthImplementation, HealthService } from './health/health.service.js';
import { createLogger } from './logging/logger.js';

function readConfigOrExit(): AppConfig {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      // Todavía no hay configuración de logs: se usa el logger por defecto.
      new Logger('Bootstrap').error(`invalid configuration: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

async function bootstrap(): Promise<void> {
  const config = readConfigOrExit();
  const logger = createLogger(config);
  Logger.overrideLogger(logger);
  const log = new Logger('Bootstrap');

  const health = createHealthImplementation();
  const app = await NestFactory.createMicroservice(AppModule.register(config, health), {
    ...grpcServerOptions(config, { health }),
    logger,
  });

  // Apagado ordenado ante SIGTERM (docker stop) o SIGINT (Ctrl+C):
  //   1. health -> NOT_SERVING, para que no llegue tráfico nuevo;
  //   2. app.close(): el servidor gRPC deja terminar las llamadas en curso y
  //      después se cierra el pool de conexiones de Prisma;
  //   3. si algo se cuelga, se fuerza la salida al cumplirse SHUTDOWN_TIMEOUT_MS.
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log.log('shutdown started', { signal, timeoutMs: config.shutdownTimeoutMs });
    setTimeout(() => {
      log.error('shutdown timed out, forcing exit', { timeoutMs: config.shutdownTimeoutMs });
      process.exit(1);
    }, config.shutdownTimeoutMs).unref();

    try {
      app.get(HealthService).markShuttingDown();
      await app.close();
      log.log('shutdown completed');
      process.exit(0);
    } catch (error) {
      log.error('shutdown failed', { error: error instanceof Error ? error.message : String(error) });
      process.exit(1);
    }
  };
  process.once('SIGTERM', (signal) => void shutdown(signal));
  process.once('SIGINT', (signal) => void shutdown(signal));

  await app.listen();
  log.log('inventory grpc listening', {
    address: `${config.grpcHost}:${config.grpcPort}`,
    database: describeDatabase(config.databaseUrl),
    reflection: config.reflectionEnabled,
    health: app.get(HealthService).getStatus(),
  });
}

await bootstrap();
