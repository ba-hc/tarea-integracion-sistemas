import * as grpc from '@grpc/grpc-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SEED_PARTS } from '../../prisma/seed-data.js';
import { seedParts } from '../../prisma/seed-parts.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { startGrpcHarness, type GrpcHarness } from './grpc-harness.js';
import { createTestPrisma, resetDatabase } from './test-database.js';

describe('InventoryService gRPC: catálogo', () => {
  let grpcHarness: GrpcHarness;
  let prisma: PrismaClient;

  const call = <T>(method: 'GetPart' | 'ListParts', request: object): Promise<T> => grpcHarness.call<T>(method, request);

  beforeAll(async () => {
    prisma = createTestPrisma();
    grpcHarness = await startGrpcHarness();
  });

  afterAll(async () => {
    await grpcHarness?.close();
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
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
      await resetDatabase(prisma);

      await expect(call('ListParts', {})).resolves.toEqual({ parts: [] });
    });
  });
});
