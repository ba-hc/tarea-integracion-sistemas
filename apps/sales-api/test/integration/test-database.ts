import type { PrismaService } from '../../src/database/prisma.service.js';

export function testDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL;
  if (!value) throw new Error('TEST_DATABASE_URL must point to a disposable Sales test database');
  const databaseName = new URL(value).pathname.slice(1);
  if (!databaseName.toLowerCase().includes('test')) {
    throw new Error(`TEST_DATABASE_URL database name must contain "test", got "${databaseName}"`);
  }
  return value;
}

export async function resetDatabase(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "idempotency_requests", "order_items", "orders", "customers" CASCADE');
}