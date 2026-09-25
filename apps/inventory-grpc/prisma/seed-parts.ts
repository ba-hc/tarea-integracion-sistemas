import type { PrismaClient } from '../src/generated/prisma/client.js';
import { SEED_PARTS } from './seed-data.js';

export type SeedMode = 'insert-missing' | 'reset';

/**
 * Carga el catálogo inicial.
 *
 * - `insert-missing` (por defecto): inserta sólo las piezas que no existen.
 *   Es seguro correrlo en cada arranque del contenedor, porque nunca pisa el
 *   stock que ya cambió por ventas reales.
 * - `reset`: además devuelve sku, nombre y stock de las piezas sembradas a
 *   sus valores iniciales (p. ej. para repetir el experimento RS-402).
 *
 * En ambos casos el resultado sobre las piezas sembradas es siempre el mismo.
 */
export async function seedParts(prisma: PrismaClient, mode: SeedMode = 'insert-missing'): Promise<number> {
  if (mode === 'insert-missing') {
    const result = await prisma.part.createMany({ data: [...SEED_PARTS], skipDuplicates: true });
    return result.count;
  }

  await prisma.$transaction(
    SEED_PARTS.map(({ id, ...values }) =>
      prisma.part.upsert({ where: { id }, create: { id, ...values }, update: values }),
    ),
  );
  return SEED_PARTS.length;
}
