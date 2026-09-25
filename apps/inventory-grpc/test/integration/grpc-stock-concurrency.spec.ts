import { randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { startGrpcHarness, type GrpcHarness } from './grpc-harness.js';
import { createPart, reserveRequest, settle, stockOf } from './stock-fixtures.js';
import { createTestPrisma, resetDatabase } from './test-database.js';

// Todas las llamadas de cada prueba se lanzan a la vez (Promise.all) contra el
// servidor real, que atiende cada una en su propia transacción de PostgreSQL.

const count = <T>(values: T[], value: T) => values.filter((v) => v === value).length;

describe('InventoryService gRPC: concurrencia', () => {
  let grpcHarness: GrpcHarness;
  let prisma: PrismaClient;

  const reserve = (orderId: string, items: Array<[string, number]>) =>
    grpcHarness.call('ReserveStock', reserveRequest(orderId, items));

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
  });

  it('caso obligatorio (TEST-MATRIX): stock 10 y 20 reservas simultáneas de 1 -> 10 éxitos, 10 FAILED_PRECONDITION, stock 0', async () => {
    const partId = await createPart(prisma, 10);

    const results = await Promise.all(
      Array.from({ length: 20 }, () => settle(reserve(randomUUID(), [[partId, 1]]))),
    );

    expect(count(results, 'OK')).toBe(10);
    expect(count(results, grpc.status.FAILED_PRECONDITION)).toBe(10);
    expect(results.every((r) => r === 'OK' || r === grpc.status.FAILED_PRECONDITION)).toBe(true);
    expect(await stockOf(prisma, partId)).toBe(0);
    // El ledger registra exactamente las 10 reservas exitosas.
    expect(await prisma.stockOperation.count()).toBe(10);
    const reserved = await prisma.stockOperationItem.aggregate({ _sum: { quantity: true }, where: { partId } });
    expect(reserved._sum.quantity).toBe(10);
  });

  it('el mismo ReserveStock enviado 10 veces a la vez descuenta una sola vez', async () => {
    const partId = await createPart(prisma, 10);
    const orderId = randomUUID();

    const responses = await Promise.all(Array.from({ length: 10 }, () => reserve(orderId, [[partId, 3]])));

    expect(count(responses.map((r) => r.replayed), false)).toBe(1);
    expect(count(responses.map((r) => r.replayed), true)).toBe(9);
    expect(await stockOf(prisma, partId)).toBe(7);
  });

  it('el mismo ReleaseStock enviado 10 veces a la vez repone una sola vez', async () => {
    const partId = await createPart(prisma, 10);
    const orderId = randomUUID();
    await reserve(orderId, [[partId, 3]]);

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => grpcHarness.call('ReleaseStock', { order_id: orderId })),
    );

    expect(count(responses.map((r) => r.replayed), false)).toBe(1);
    expect(await stockOf(prisma, partId)).toBe(10);
  });

  it('órdenes con las mismas piezas en orden inverso no producen deadlocks', async () => {
    const x = await createPart(prisma, 1000);
    const y = await createPart(prisma, 1000);

    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        settle(reserve(randomUUID(), i % 2 === 0 ? [[x, 1], [y, 1]] : [[y, 1], [x, 1]])),
      ),
    );

    expect(results.every((r) => r === 'OK')).toBe(true);
    expect(await stockOf(prisma, x)).toBe(960);
    expect(await stockOf(prisma, y)).toBe(960);
  });

  it('bajo reservas y liberaciones mezcladas, stock = inicial - reservas vigentes', async () => {
    const partId = await createPart(prisma, 30);
    const toRelease = Array.from({ length: 10 }, () => randomUUID());
    await Promise.all(toRelease.map((orderId) => reserve(orderId, [[partId, 2]])));

    // A la vez: 10 liberaciones y 20 reservas nuevas de 1 unidad (quedan 10 + lo liberado).
    const results = await Promise.all([
      ...toRelease.map((orderId) => settle(grpcHarness.call('ReleaseStock', { order_id: orderId }))),
      ...Array.from({ length: 20 }, () => settle(reserve(randomUUID(), [[partId, 1]]))),
    ]);

    expect(results.every((r) => r === 'OK' || r === grpc.status.FAILED_PRECONDITION)).toBe(true);
    const active = await prisma.stockOperationItem.aggregate({
      _sum: { quantity: true },
      where: { partId, operation: { status: 'RESERVED' } },
    });
    const stock = await stockOf(prisma, partId);
    expect(stock).toBe(30 - (active._sum.quantity ?? 0));
    expect(stock).toBeGreaterThanOrEqual(0);
  });
});
