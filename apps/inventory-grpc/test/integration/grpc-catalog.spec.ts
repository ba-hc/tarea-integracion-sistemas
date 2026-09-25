import 'reflect-metadata';
import { createServer } from 'node:net';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import type { INestMicroservice } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SEED_PARTS } from '../../prisma/seed-data.js';
import { seedParts } from '../../prisma/seed-parts.js';
import { AppModule } from '../../src/app.module.js';
import { loadConfig } from '../../src/config/app-config.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { grpcServerOptions } from '../../src/grpc/grpc-server-options.js';
import { createTestPrisma, testDatabaseUrl, truncateParts } from './test-database.js';

// Prueba de caja negra del servidor gRPC real: el cliente se construye sólo a
// partir del .proto congelado, igual que lo hará Sales.

type Callback<T> = (error: grpc.ServiceError | null, response: T) => void;
interface InventoryClient extends grpc.Client {
  GetPart(request: object, options: grpc.CallOptions, callback: Callback<any>): void;
  ListParts(request: object, options: grpc.CallOptions, callback: Callback<any>): void;
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

describe('InventoryService gRPC: catálogo', () => {
  let app: INestMicroservice;
  let client: InventoryClient;
  let prisma: PrismaClient;

  const call = <T>(method: 'GetPart' | 'ListParts', request: object): Promise<T> =>
    new Promise((resolve, reject) => {
      client[method](request, { deadline: Date.now() + 5_000 }, (error, response) =>
        error ? reject(error) : resolve(response as T),
      );
    });

  beforeAll(async () => {
    prisma = createTestPrisma();
    const port = await freePort();
    const config = loadConfig({ DATABASE_URL: testDatabaseUrl(), GRPC_HOST: '127.0.0.1', GRPC_PORT: String(port) });

    app = await NestFactory.createMicroservice(AppModule.register(config), {
      ...grpcServerOptions(config),
      logger: false,
    });
    await app.listen();

    const definition = protoLoader.loadSync(config.protoPath, { keepCase: true, longs: String, defaults: true });
    const pkg = grpc.loadPackageDefinition(definition) as any;
    client = new pkg.repuestossur.inventory.v1.InventoryService(
      `127.0.0.1:${port}`,
      grpc.credentials.createInsecure(),
    ) as InventoryClient;
  });

  afterAll(async () => {
    client?.close();
    await app?.close();
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    await truncateParts(prisma);
    await seedParts(prisma);
  });

  describe('GetPart', () => {
    it('devuelve la pieza y su stock actual', async () => {
      const seeded = SEED_PARTS[0]!;
      const row = await prisma.part.findUniqueOrThrow({ where: { id: seeded.id } });

      const response = await call<any>('GetPart', { part_id: seeded.id });

      expect(response.part).toEqual({
        id: seeded.id,
        sku: seeded.sku,
        name: seeded.name,
        stock_available: seeded.stockAvailable,
        updated_at: {
          seconds: String(Math.floor(row.updatedAt.getTime() / 1000)),
          nanos: (row.updatedAt.getTime() % 1000) * 1_000_000,
        },
      });
    });

    it('refleja el stock persistido, no un valor en memoria', async () => {
      const id = SEED_PARTS[0]!.id;
      await prisma.part.update({ where: { id }, data: { stockAvailable: 3 } });

      const response = await call<any>('GetPart', { part_id: id });

      expect(response.part.stock_available).toBe(3);
    });

    it('acepta el UUID en mayúsculas', async () => {
      const response = await call<any>('GetPart', { part_id: SEED_PARTS[0]!.id.toUpperCase() });

      expect(response.part.id).toBe(SEED_PARTS[0]!.id);
    });

    it('devuelve NOT_FOUND si la pieza no existe', async () => {
      await expect(call('GetPart', { part_id: '00000000-0000-4000-8000-000000000000' })).rejects.toMatchObject({
        code: grpc.status.NOT_FOUND,
      });
    });

    it.each(['', 'nope', '123e4567'])('devuelve INVALID_ARGUMENT para part_id=%j', async (partId) => {
      await expect(call('GetPart', { part_id: partId })).rejects.toMatchObject({
        code: grpc.status.INVALID_ARGUMENT,
      });
    });
  });

  describe('ListParts', () => {
    it('devuelve el inventario persistido completo', async () => {
      const response = await call<any>('ListParts', {});

      const expectedSkus = SEED_PARTS.map((part) => part.sku).sort();
      expect(response.parts.map((part: any) => part.sku)).toEqual(expectedSkus);
      for (const part of response.parts) {
        const seeded = SEED_PARTS.find((p) => p.id === part.id);
        expect(part.stock_available).toBe(seeded?.stockAvailable);
        expect(Number(part.updated_at.seconds)).toBeGreaterThan(0);
      }
    });

    it('incluye piezas agregadas después del seed', async () => {
      await prisma.part.create({ data: { sku: 'ZZZ-NEW-999', name: 'Pieza nueva', stockAvailable: 4 } });

      const response = await call<any>('ListParts', {});

      expect(response.parts).toHaveLength(SEED_PARTS.length + 1);
      expect(response.parts.at(-1)).toMatchObject({ sku: 'ZZZ-NEW-999', stock_available: 4 });
    });

    it('devuelve una lista vacía si no hay piezas', async () => {
      await truncateParts(prisma);

      await expect(call('ListParts', {})).resolves.toEqual({ parts: [] });
    });
  });

  it('ReserveStock todavía no está implementado (RS-202)', async () => {
    await expect(
      new Promise((resolve, reject) =>
        (client as any).ReserveStock({ order_id: SEED_PARTS[0]!.id }, (error: unknown, res: unknown) =>
          error ? reject(error) : resolve(res),
        ),
      ),
    ).rejects.toMatchObject({ code: grpc.status.UNIMPLEMENTED });
  });
});
