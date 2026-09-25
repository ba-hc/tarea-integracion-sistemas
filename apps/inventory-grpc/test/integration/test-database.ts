import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client.js';

/**
 * URL de la base desechable de pruebas. Las pruebas borran tablas, así que se
 * exige que el nombre de la base contenga "test" para no apuntar por error a
 * la base de desarrollo.
 */
export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error('TEST_DATABASE_URL no está definida (ver apps/inventory-grpc/README.md)');
  }
  const databaseName = new URL(url).pathname.slice(1);
  if (!databaseName.includes('test')) {
    throw new Error(`TEST_DATABASE_URL apunta a "${databaseName}"; el nombre debe contener "test"`);
  }
  return url;
}

export function createTestPrisma(): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: testDatabaseUrl() }) });
}

/** Deja la base vacía: catálogo y ledger. */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "stock_operation_items", "stock_operations", "parts"');
}
