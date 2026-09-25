import 'reflect-metadata';
import { createServer } from 'node:net';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import type { INestMicroservice, LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { protoPath as healthProtoPath } from 'grpc-health-check';
import { AppModule } from '../../src/app.module.js';
import { loadConfig, type AppConfig } from '../../src/config/app-config.js';
import { grpcServerOptions } from '../../src/grpc/grpc-server-options.js';
import { createHealthImplementation } from '../../src/health/health.service.js';
import { testDatabaseUrl } from './test-database.js';

// Servidor gRPC real (mismo módulo y opciones que main.ts) contra la base de
// pruebas, y clientes construidos sólo a partir de los .proto, igual que lo
// hará Sales. Las pruebas que lo usan son de caja negra.

export type InventoryMethod = 'GetPart' | 'ListParts' | 'ReserveStock' | 'ReleaseStock';

export interface HarnessOptions {
  /** Variables de entorno extra para loadConfig (p. ej. GRPC_REFLECTION). */
  env?: NodeJS.ProcessEnv;
  /** Logger de Nest; por defecto, silencio. */
  logger?: LoggerService | false;
}

export interface GrpcHarness {
  app: INestMicroservice;
  config: AppConfig;
  address: string;
  call<T = any>(method: InventoryMethod, request: object, metadata?: Record<string, string>): Promise<T>;
  /** grpc.health.v1.Health/Check; devuelve el status ('SERVING', 'NOT_SERVING'...). */
  healthCheck(service?: string): Promise<string>;
  close(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

function unary<T>(client: any, method: string, request: object, metadata = new grpc.Metadata()): Promise<T> {
  return new Promise((resolve, reject) => {
    client[method](request, metadata, { deadline: Date.now() + 10_000 }, (error: grpc.ServiceError | null, response: T) =>
      error ? reject(error) : resolve(response),
    );
  });
}

export async function startGrpcHarness(options: HarnessOptions = {}): Promise<GrpcHarness> {
  const port = await freePort();
  const config = loadConfig({
    DATABASE_URL: testDatabaseUrl(),
    GRPC_HOST: '127.0.0.1',
    GRPC_PORT: String(port),
    ...options.env,
  });
  const address = `127.0.0.1:${port}`;

  const health = createHealthImplementation();
  const app = await NestFactory.createMicroservice(AppModule.register(config, health), {
    ...grpcServerOptions(config, { health }),
    logger: options.logger ?? false,
  });
  await app.listen();

  const inventoryDefinition = protoLoader.loadSync(config.protoPath, { keepCase: true, longs: String, defaults: true });
  const inventory = new (grpc.loadPackageDefinition(inventoryDefinition) as any).repuestossur.inventory.v1.InventoryService(
    address,
    grpc.credentials.createInsecure(),
  );
  const healthDefinition = protoLoader.loadSync(healthProtoPath, { keepCase: true, enums: String, defaults: true });
  const healthClient = new (grpc.loadPackageDefinition(healthDefinition) as any).grpc.health.v1.Health(
    address,
    grpc.credentials.createInsecure(),
  );

  return {
    app,
    config,
    address,
    call: (method, request, metadata = {}) => {
      const grpcMetadata = new grpc.Metadata();
      for (const [key, value] of Object.entries(metadata)) {
        grpcMetadata.set(key, value);
      }
      return unary(inventory, method, request, grpcMetadata);
    },
    healthCheck: async (service = '') => (await unary<{ status: string }>(healthClient, 'Check', { service })).status,
    close: async () => {
      inventory.close();
      healthClient.close();
      await app.close();
    },
  };
}
