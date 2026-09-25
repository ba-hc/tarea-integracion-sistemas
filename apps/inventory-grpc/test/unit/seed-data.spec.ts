import { describe, expect, it } from 'vitest';
import { EXPERIMENT_PART_ID, SEED_PARTS, SYSTEM_TEST_PART_ID, SYSTEM_TEST_PART_STOCK } from '../../prisma/seed-data.js';
import { isUuid } from '../../src/common/uuid.js';

describe('SEED_PARTS', () => {
  it('tiene entre 15 y 30 repuestos', () => {
    expect(SEED_PARTS.length).toBeGreaterThanOrEqual(15);
    expect(SEED_PARTS.length).toBeLessThanOrEqual(30);
  });

  it('usa UUID válidos y únicos', () => {
    const ids = SEED_PARTS.map((part) => part.id);
    expect(ids.every(isUuid)).toBe(true);
    expect(new Set(ids.map((id) => id.toLowerCase())).size).toBe(ids.length);
  });

  it('usa SKU únicos que caben en la columna', () => {
    const skus = SEED_PARTS.map((part) => part.sku);
    expect(new Set(skus).size).toBe(skus.length);
    expect(skus.every((sku) => sku.length > 0 && sku.length <= 40)).toBe(true);
  });

  it('usa nombres que caben en la columna', () => {
    expect(SEED_PARTS.every((part) => part.name.length > 0 && part.name.length <= 120)).toBe(true);
  });

  it('nunca siembra stock negativo', () => {
    expect(SEED_PARTS.every((part) => Number.isInteger(part.stockAvailable) && part.stockAvailable >= 0)).toBe(true);
  });

  it('incluye piezas sin stock para demostrar el rechazo', () => {
    expect(SEED_PARTS.some((part) => part.stockAvailable === 0)).toBe(true);
  });

  it('incluye la pieza del experimento RS-402 con stock >= 50000', () => {
    const part = SEED_PARTS.find((p) => p.id === EXPERIMENT_PART_ID);
    expect(part?.stockAvailable).toBeGreaterThanOrEqual(50_000);
  });

  it('incluye la pieza de pruebas de sistema RS-401 con stock 5 (la suite exige 1..20)', () => {
    const part = SEED_PARTS.find((p) => p.id === SYSTEM_TEST_PART_ID);
    expect(SYSTEM_TEST_PART_STOCK).toBe(5);
    expect(part?.stockAvailable).toBe(SYSTEM_TEST_PART_STOCK);
  });
});
