import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidArgumentError, PartNotFoundError } from '../../src/common/inventory-errors.js';
import type { Part } from '../../src/generated/prisma/client.js';
import { toProtoPart } from '../../src/parts/part.mapper.js';
import { PartsService } from '../../src/parts/parts.service.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';

const PART: Part = {
  id: 'd6e1fd98-cb07-458f-aa12-6fe220b37604',
  sku: 'MOT-BUJ-IRI-009',
  name: 'Bujía de iridio',
  stockAvailable: 200,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-24T12:00:00.250Z'),
};

describe('PartsService', () => {
  const findUnique = vi.fn();
  const findMany = vi.fn();
  let service: PartsService;

  beforeEach(() => {
    findUnique.mockReset();
    findMany.mockReset();
    const prisma = { part: { findUnique, findMany } } as unknown as PrismaService;
    service = new PartsService(prisma);
  });

  describe('getPart', () => {
    it('devuelve la pieza encontrada por id', async () => {
      findUnique.mockResolvedValue(PART);

      await expect(service.getPart(PART.id)).resolves.toBe(PART);
      expect(findUnique).toHaveBeenCalledWith({ where: { id: PART.id } });
    });

    it('lanza PartNotFoundError si no existe', async () => {
      findUnique.mockResolvedValue(null);

      await expect(service.getPart(PART.id)).rejects.toBeInstanceOf(PartNotFoundError);
    });

    it.each(['', 'nope', '123'])('rechaza %j sin consultar la base', async (id) => {
      await expect(service.getPart(id)).rejects.toBeInstanceOf(InvalidArgumentError);
      expect(findUnique).not.toHaveBeenCalled();
    });
  });

  describe('listParts', () => {
    it('devuelve todo el inventario ordenado por sku', async () => {
      findMany.mockResolvedValue([PART]);

      await expect(service.listParts()).resolves.toEqual([PART]);
      expect(findMany).toHaveBeenCalledWith({ orderBy: { sku: 'asc' } });
    });
  });
});

describe('toProtoPart', () => {
  it('mapea la fila al mensaje Part del contrato', () => {
    expect(toProtoPart(PART)).toEqual({
      id: PART.id,
      sku: PART.sku,
      name: PART.name,
      stock_available: 200,
      updated_at: { seconds: 1790251200, nanos: 250_000_000 },
    });
  });
});
