import 'reflect-metadata';
import { createServer } from 'node:net';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import type { INestMicroservice } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module.js';
import { loadConfig } from '../../src/config/app-config.js';
import { grpcServerOptions } from '../../src/grpc/grpc-server-options.js';
import { testDatabaseUrl } from './test-database.js';

// Servidor gRPC real (mismo módulo y opciones que main.ts) contra la base de
// pruebas, y un cliente construido sólo a partir del .proto congelado, igual
// que lo hará Sales. Las pruebas que lo usan son de caja negra.

export type InventoryMethod = 'GetPart' | 'ListParts' | 'ReserveStock' | 'ReleaseStock';

export interface GrpcHarness {
  call<T = any>(method: InventoryMethod, request: object): Promise<T>;
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

export async function startGrpcHarness(): Promise<GrpcHarness> {
  const port = await freePort();
  const config = loadConfig({ DATABASE_URL: testDatabaseUrl(), GRPC_HOST: '127.0.0.1', GRPC_PORT: String(port) });

  const app: INestMicroservice = await NestFactory.createMicroservice(AppModule.register(config), {
    ...grpcServerOptions(config),
    logger: false,
  });
  await app.listen();

  const definition = protoLoader.loadSync(config.protoPath, { keepCase: true, longs: String, defaults: true });
  const pkg = grpc.loadPackageDefinition(definition) as any;
  const client: grpc.Client & Record<InventoryMethod, Function> = new pkg.repuestossur.inventory.v1.InventoryService(
    `127.0.0.1:${port}`,
    grpc.credentials.createInsecure(),
  );

  return {
    call: (method, request) =>
      new Promise((resolve, reject) => {
        client[method](request, { deadline: Date.now() + 10_000 }, (error: grpc.ServiceError | null, response: any) =>
          error ? reject(error) : resolve(response),
        );
      }),
    close: async () => {
      client.close();
      await app.close();
    },
  };
}
