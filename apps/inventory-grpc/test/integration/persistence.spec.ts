import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EXPERIMENT_PART_ID, SEED_PARTS } from '../../prisma/seed-data.js';
import { seedParts } from '../../prisma/seed-parts.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { createTestPrisma, truncateParts } from './test-database.js';

const snapshot = (prisma: PrismaClient) =>
  prisma.part.findMany({ orderBy: { id: 'asc' }, select: { id: true, sku: true, name: true, stockAvailable: true } });

describe('persistencia de parts (PostgreSQL real)', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createTestPrisma();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateParts(prisma);
  });

  describe('restricciones del esquema', () => {
    it('la base rechaza stock negativo (CHECK stock_available >= 0)', async () => {
      await seedParts(prisma);
      const id = SEED_PARTS[0]!.id;

      await expect(prisma.part.update({ where: { id }, data: { stockAvailable: -1 } })).rejects.toThrow();
      expect((await prisma.part.findUniqueOrThrow({ where: { id } })).stockAvailable).toBe(SEED_PARTS[0]!.stockAvailable);
    });

    it('la base rechaza SKU duplicado', async () => {
      await prisma.part.create({ data: { sku: 'DUP-001', name: 'A', stockAvailable: 1 } });

      await expect(prisma.part.create({ data: { sku: 'DUP-001', name: 'B', stockAvailable: 1 } })).rejects.toThrow();
    });

    it('updated_at cambia al modificar la pieza', async () => {
      await seedParts(prisma);
      const before = await prisma.part.findUniqueOrThrow({ where: { id: EXPERIMENT_PART_ID } });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const after = await prisma.part.update({ where: { id: EXPERIMENT_PART_ID }, data: { stockAvailable: 1 } });

      expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    });
  });

  describe('seed reproducible', () => {
    const expected = [...SEED_PARTS]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(({ id, sku, name, stockAvailable }) => ({ id, sku, name, stockAvailable }));

    it('sobre una base vacía deja exactamente el catálogo definido', async () => {
      await expect(seedParts(prisma)).resolves.toBe(SEED_PARTS.length);

      expect(await snapshot(prisma)).toEqual(expected);
    });

    it('correrlo dos veces no duplica ni cambia nada', async () => {
      await seedParts(prisma);
      await expect(seedParts(prisma)).resolves.toBe(0);

      expect(await snapshot(prisma)).toEqual(expected);
    });

    it('en modo por defecto no pisa el stock que ya cambió', async () => {
      await seedParts(prisma);
      await prisma.part.update({ where: { id: EXPERIMENT_PART_ID }, data: { stockAvailable: 7 } });

      await seedParts(prisma);

      expect((await prisma.part.findUniqueOrThrow({ where: { id: EXPERIMENT_PART_ID } })).stockAvailable).toBe(7);
    });

    it('en modo reset restaura los valores iniciales', async () => {
      await seedParts(prisma);
      await prisma.part.update({ where: { id: EXPERIMENT_PART_ID }, data: { stockAvailable: 7, name: 'otro' } });

      await seedParts(prisma, 'reset');

      expect(await snapshot(prisma)).toEqual(expected);
    });
  });
});
