import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../src/generated/prisma/client.js';

let sequence = 0;

/** Crea una pieza de prueba con el stock indicado y devuelve su id. */
export async function createPart(prisma: PrismaClient, stockAvailable: number): Promise<string> {
  sequence += 1;
  const part = await prisma.part.create({
    data: { sku: `TST-${sequence}-${randomUUID().slice(0, 8)}`, name: `Pieza de prueba ${sequence}`, stockAvailable },
  });
  return part.id;
}

export async function stockOf(prisma: PrismaClient, partId: string): Promise<number> {
  return (await prisma.part.findUniqueOrThrow({ where: { id: partId } })).stockAvailable;
}

export function reserveRequest(orderId: string, items: Array<[partId: string, quantity: number]>) {
  return { order_id: orderId, items: items.map(([part_id, quantity]) => ({ part_id, quantity })) };
}

/** Resultado de una llamada gRPC: 'OK' o el código de estado del error. */
export async function settle(promise: Promise<unknown>): Promise<'OK' | number> {
  try {
    await promise;
    return 'OK';
  } catch (error) {
    return (error as { code: number }).code;
  }
}
