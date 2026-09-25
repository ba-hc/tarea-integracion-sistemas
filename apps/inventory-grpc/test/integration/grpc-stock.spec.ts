import { randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { startGrpcHarness, type GrpcHarness } from './grpc-harness.js';
import { createPart, reserveRequest, stockOf } from './stock-fixtures.js';
import { createTestPrisma, resetDatabase } from './test-database.js';

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

describe('InventoryService gRPC: ReserveStock / ReleaseStock', () => {
  let grpcHarness: GrpcHarness;
  let prisma: PrismaClient;
  let partA: string; // stock 10
  let partB: string; // stock 5

  const reserve = (orderId: string, items: Array<[string, number]>) =>
    grpcHarness.call('ReserveStock', reserveRequest(orderId, items));
  const release = (orderId: string) => grpcHarness.call('ReleaseStock', { order_id: orderId });
  const operationCount = () => prisma.stockOperation.count();

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
    partA = await createPart(prisma, 10);
    partB = await createPart(prisma, 5);
  });

  describe('ReserveStock', () => {
    it('descuenta todos los ítems y responde con el antes/después de cada uno', async () => {
      const orderId = randomUUID();

      const response = await reserve(orderId, [[partA, 3], [partB, 5]]);

      expect(response.order_id).toBe(orderId);
      expect(response.replayed).toBe(false);
      expect(response.items).toMatchObject([
        { part: { id: partA, stock_available: 7 }, quantity: 3, stock_before: 10, stock_after: 7 },
        { part: { id: partB, stock_available: 0 }, quantity: 5, stock_before: 5, stock_after: 0 },
      ]);
      expect(response.items[0].part.updated_at).toEqual(response.processed_at);
      expect(Number(response.processed_at.seconds)).toBeGreaterThan(0);

      expect(await stockOf(prisma, partA)).toBe(7);
      expect(await stockOf(prisma, partB)).toBe(0);
      const operation = await prisma.stockOperation.findUniqueOrThrow({ where: { orderId } });
      expect(operation.status).toBe('RESERVED');
    });

    it('responde los ítems en el orden de la solicitud', async () => {
      const response = await reserve(randomUUID(), [[partB, 1], [partA, 1]]);

      expect(response.items.map((item: any) => item.part.id)).toEqual([partB, partA]);
    });

    describe('todo o nada', () => {
      it('stock insuficiente en una línea -> FAILED_PRECONDITION y ninguna pieza cambia', async () => {
        await expect(reserve(randomUUID(), [[partA, 3], [partB, 6]])).rejects.toMatchObject({
          code: grpc.status.FAILED_PRECONDITION,
        });

        expect(await stockOf(prisma, partA)).toBe(10);
        expect(await stockOf(prisma, partB)).toBe(5);
        expect(await operationCount()).toBe(0);
      });

      it('pieza inexistente en una línea -> NOT_FOUND y ninguna pieza cambia', async () => {
        await expect(reserve(randomUUID(), [[partA, 3], [UNKNOWN_ID, 1]])).rejects.toMatchObject({
          code: grpc.status.NOT_FOUND,
        });

        expect(await stockOf(prisma, partA)).toBe(10);
        expect(await operationCount()).toBe(0);
      });

      it('permite reservar exactamente todo el stock disponible', async () => {
        await reserve(randomUUID(), [[partA, 10]]);

        expect(await stockOf(prisma, partA)).toBe(0);
      });
    });

    describe('idempotencia por order_id', () => {
      it('repetir la misma reserva devuelve el resultado original sin descontar de nuevo', async () => {
        const orderId = randomUUID();
        const first = await reserve(orderId, [[partA, 3], [partB, 2]]);

        const second = await reserve(orderId, [[partA, 3], [partB, 2]]);

        expect(second).toEqual({ ...first, replayed: true });
        expect(await stockOf(prisma, partA)).toBe(7);
        expect(await stockOf(prisma, partB)).toBe(3);
        expect(await operationCount()).toBe(1);
      });

      it('el replay no depende del orden de los ítems ni de mayúsculas en los UUID', async () => {
        const orderId = randomUUID();
        await reserve(orderId, [[partA, 3], [partB, 2]]);

        const second = await reserve(orderId.toUpperCase(), [[partB.toUpperCase(), 2], [partA, 3]]);

        expect(second.replayed).toBe(true);
        expect(await stockOf(prisma, partA)).toBe(7);
      });

      it('el replay devuelve la foto original aunque el stock cambió después', async () => {
        const orderId = randomUUID();
        const first = await reserve(orderId, [[partA, 3]]);
        await reserve(randomUUID(), [[partA, 4]]);

        const second = await reserve(orderId, [[partA, 3]]);

        expect(second.items).toEqual(first.items);
        expect(await stockOf(prisma, partA)).toBe(3);
      });

      it.each<[string, Array<[number, number]>]>([
        ['otra cantidad', [[0, 4]]],
        ['otra pieza', [[1, 3]]],
        ['una pieza extra', [[0, 3], [1, 1]]],
      ])('mismo order_id con %s -> ALREADY_EXISTS sin mutar stock', async (_label, items) => {
        const orderId = randomUUID();
        await reserve(orderId, [[partA, 3]]);
        const parts = [partA, partB];

        await expect(
          reserve(orderId, items.map(([index, quantity]) => [parts[index]!, quantity])),
        ).rejects.toMatchObject({ code: grpc.status.ALREADY_EXISTS });

        expect(await stockOf(prisma, partA)).toBe(7);
        expect(await stockOf(prisma, partB)).toBe(5);
        expect(await operationCount()).toBe(1);
      });

      it('una reserva fallida no consume el order_id: puede reintentarse cuando haya stock', async () => {
        const orderId = randomUUID();
        await expect(reserve(orderId, [[partB, 6]])).rejects.toMatchObject({ code: grpc.status.FAILED_PRECONDITION });
        await prisma.part.update({ where: { id: partB }, data: { stockAvailable: 6 } });

        const response = await reserve(orderId, [[partB, 6]]);

        expect(response.replayed).toBe(false);
        expect(await stockOf(prisma, partB)).toBe(0);
      });
    });

    describe('validación -> INVALID_ARGUMENT sin tocar la base', () => {
      const item = (partId: string, quantity = 1) => ({ part_id: partId, quantity });

      it.each<[string, () => object]>([
        ['order_id vacío', () => ({ order_id: '', items: [item(partA)] })],
        ['order_id que no es UUID', () => ({ order_id: 'orden-1', items: [item(partA)] })],
        ['items vacío', () => ({ order_id: randomUUID(), items: [] })],
        ['más de 50 ítems', () => ({ order_id: randomUUID(), items: Array.from({ length: 51 }, () => item(randomUUID())) })],
        ['part_id que no es UUID', () => ({ order_id: randomUUID(), items: [item('x')] })],
        ['cantidad 0', () => ({ order_id: randomUUID(), items: [item(partA, 0)] })],
        ['cantidad negativa', () => ({ order_id: randomUUID(), items: [item(partA, -1)] })],
        ['cantidad 1000', () => ({ order_id: randomUUID(), items: [item(partA, 1000)] })],
        ['pieza duplicada', () => ({ order_id: randomUUID(), items: [item(partA), item(partA)] })],
        ['pieza duplicada con otra capitalización', () => ({ order_id: randomUUID(), items: [item(partA), item(partA.toUpperCase())] })],
      ])('%s', async (_label, request) => {
        await expect(grpcHarness.call('ReserveStock', request())).rejects.toMatchObject({
          code: grpc.status.INVALID_ARGUMENT,
        });
        expect(await stockOf(prisma, partA)).toBe(10);
        expect(await operationCount()).toBe(0);
      });

      it('acepta 50 ítems y cantidad 999 (límites incluidos)', async () => {
        const parts = await Promise.all(Array.from({ length: 50 }, () => createPart(prisma, 999)));

        const response = await reserve(randomUUID(), parts.map((id) => [id, 999] as [string, number]));

        expect(response.items).toHaveLength(50);
      });
    });
  });

  describe('ReleaseStock', () => {
    it('repone todo lo reservado por la orden', async () => {
      const orderId = randomUUID();
      await reserve(orderId, [[partA, 3], [partB, 5]]);

      const response = await release(orderId);

      expect(response.order_id).toBe(orderId);
      expect(response.replayed).toBe(false);
      expect(response.items).toMatchObject([
        { part: { id: partA, stock_available: 10 }, quantity: 3, stock_before: 7, stock_after: 10 },
        { part: { id: partB, stock_available: 5 }, quantity: 5, stock_before: 0, stock_after: 5 },
      ]);
      expect(await stockOf(prisma, partA)).toBe(10);
      expect(await stockOf(prisma, partB)).toBe(5);
      const operation = await prisma.stockOperation.findUniqueOrThrow({ where: { orderId } });
      expect(operation.status).toBe('RELEASED');
      expect(operation.releasedAt).not.toBeNull();
    });

    it('repetir la liberación devuelve el resultado original sin reponer dos veces', async () => {
      const orderId = randomUUID();
      await reserve(orderId, [[partA, 3]]);
      const first = await release(orderId);

      const second = await release(orderId);

      expect(second).toEqual({ ...first, replayed: true });
      expect(await stockOf(prisma, partA)).toBe(10);
    });

    it('repone sobre el stock actual, respetando movimientos de otras órdenes', async () => {
      const orderId = randomUUID();
      await reserve(orderId, [[partA, 3]]);
      await reserve(randomUUID(), [[partA, 2]]);

      const response = await release(orderId);

      expect(response.items[0]).toMatchObject({ stock_before: 5, stock_after: 8 });
      expect(await stockOf(prisma, partA)).toBe(8);
    });

    it('order_id inválido -> INVALID_ARGUMENT', async () => {
      await expect(release('nope')).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
    });

    // Casos no definidos en ERROR-MAPPING.md: comportamiento PROVISORIO.
    describe('casos no definidos por el contrato (provisorio)', () => {
      it('order_id sin reserva -> NOT_FOUND', async () => {
        await expect(release(randomUUID())).rejects.toMatchObject({ code: grpc.status.NOT_FOUND });
      });

      it('reservar de nuevo un order_id ya liberado -> FAILED_PRECONDITION sin mutar stock', async () => {
        const orderId = randomUUID();
        await reserve(orderId, [[partA, 3]]);
        await release(orderId);

        await expect(reserve(orderId, [[partA, 3]])).rejects.toMatchObject({
          code: grpc.status.FAILED_PRECONDITION,
        });
        expect(await stockOf(prisma, partA)).toBe(10);
      });
    });
  });
});
