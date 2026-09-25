import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import type { LoggerService } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SEED_PARTS } from '../../prisma/seed-data.js';
import { seedParts } from '../../prisma/seed-parts.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { HealthService } from '../../src/health/health.service.js';
import { startGrpcHarness, type GrpcHarness } from './grpc-harness.js';
import { createPart, reserveRequest, stockOf } from './stock-fixtures.js';
import { createTestPrisma, resetDatabase } from './test-database.js';

// RS-203: health check, reflection, errores internos, logs correlacionables y
// apagado ordenado, probados contra el servidor real.

const INVENTORY_SERVICE_NAME = 'repuestossur.inventory.v1.InventoryService';

/** Llama a grpc.reflection.v1 como lo haría grpcurl: `list`. */
function listServicesByReflection(address: string): Promise<string[]> {
  const require = createRequire(import.meta.url);
  const reflectionRoot = join(dirname(require.resolve('@grpc/reflection/package.json')), 'build/proto');
  const definition = protoLoader.loadSync('grpc/reflection/v1/reflection.proto', {
    includeDirs: [reflectionRoot],
    keepCase: true,
    defaults: true,
    oneofs: true,
  });
  const { grpc: grpcPackage } = grpc.loadPackageDefinition(definition) as any;
  const client = new grpcPackage.reflection.v1.ServerReflection(address, grpc.credentials.createInsecure());

  return new Promise((resolve, reject) => {
    const stream = client.ServerReflectionInfo({ deadline: Date.now() + 5_000 });
    stream.on('data', (response: any) => {
      stream.end();
      client.close();
      if (response.error_response) {
        reject(new Error(response.error_response.error_message));
      } else {
        resolve(response.list_services_response.service.map((s: { name: string }) => s.name));
      }
    });
    stream.on('error', (error: Error) => {
      client.close();
      reject(error);
    });
    stream.write({ list_services: '' });
  });
}

/** Logger que guarda las entradas para inspeccionarlas en la prueba. */
class CapturingLogger implements LoggerService {
  readonly entries: Array<{ level: string; message: unknown; params: unknown[] }> = [];
  log(message: unknown, ...params: unknown[]) {
    this.entries.push({ level: 'log', message, params });
  }
  error(message: unknown, ...params: unknown[]) {
    this.entries.push({ level: 'error', message, params });
  }
  warn(message: unknown, ...params: unknown[]) {
    this.entries.push({ level: 'warn', message, params });
  }
}

describe('InventoryService gRPC: operación (RS-203)', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createTestPrisma();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    await seedParts(prisma);
  });

  describe('con un servidor compartido', () => {
    let harness: GrpcHarness;
    let logger: CapturingLogger;

    beforeAll(async () => {
      logger = new CapturingLogger();
      harness = await startGrpcHarness({ logger });
    });

    afterAll(async () => {
      await harness?.close();
    });

    it('health check: SERVING para el servidor y para InventoryService', async () => {
      await expect(harness.healthCheck('')).resolves.toBe('SERVING');
      await expect(harness.healthCheck(INVENTORY_SERVICE_NAME)).resolves.toBe('SERVING');
    });

    it('health check: servicio desconocido -> NOT_FOUND', async () => {
      await expect(harness.healthCheck('otro.Servicio')).rejects.toMatchObject({ code: grpc.status.NOT_FOUND });
    });

    it('reflection lista InventoryService y el health check', async () => {
      const services = await listServicesByReflection(harness.address);

      expect(services).toEqual(expect.arrayContaining([INVENTORY_SERVICE_NAME, 'grpc.health.v1.Health']));
    });

    describe('un error interno de base de datos', () => {
      afterEach(async () => {
        await prisma.$executeRawUnsafe('ALTER TABLE IF EXISTS "parts_renamed_by_test" RENAME TO "parts"');
      });

      it('responde INTERNAL genérico sin SQL, Prisma ni stack, y lo registra con traceId', async () => {
        // Simula una falla de base: la tabla desaparece mientras el servicio corre.
        await prisma.$executeRawUnsafe('ALTER TABLE "parts" RENAME TO "parts_renamed_by_test"');
        logger.entries.length = 0;

        const failures = await Promise.all([
          harness.call('GetPart', { part_id: SEED_PARTS[0]!.id }, { 'x-trace-id': 'trace-internal-1' }).catch((e) => e),
          harness.call('ListParts', {}).catch((e) => e),
          harness.call('ReserveStock', reserveRequest(randomUUID(), [[SEED_PARTS[0]!.id, 1]])).catch((e) => e),
        ]);

        for (const failure of failures) {
          expect(failure).toMatchObject({ code: grpc.status.INTERNAL, details: 'Internal error' });
          expect(JSON.stringify({ details: failure.details, metadata: failure.metadata?.getMap() })).not.toMatch(
            /parts|relation|prisma|select|at \w+/i,
          );
        }

        const logged = logger.entries.find(
          (e) => e.level === 'error' && (e.params[0] as { traceId?: string })?.traceId === 'trace-internal-1',
        );
        expect(logged?.message).toBe('grpc call failed unexpectedly');
        expect(logged?.params[0]).toMatchObject({ method: 'GetPart', code: 'INTERNAL' });
        expect(String((logged?.params[0] as { error: string }).error)).toMatch(/parts/);
      });
    });

    it('registra cada llamada con el traceId que envía el llamador', async () => {
      logger.entries.length = 0;

      await harness.call('GetPart', { part_id: SEED_PARTS[0]!.id }, { 'x-trace-id': 'sales-trace-42' });

      expect(logger.entries).toContainEqual({
        level: 'log',
        message: 'grpc call completed',
        params: [
          expect.objectContaining({ method: 'GetPart', code: 'OK', traceId: 'sales-trace-42', partId: SEED_PARTS[0]!.id }),
          'GrpcCall',
        ],
      });
    });
  });

  it('reflection se puede desactivar con GRPC_REFLECTION=false', async () => {
    const harness = await startGrpcHarness({ env: { GRPC_REFLECTION: 'false' } });
    try {
      await expect(listServicesByReflection(harness.address)).rejects.toMatchObject({ code: grpc.status.UNIMPLEMENTED });
      await expect(harness.healthCheck()).resolves.toBe('SERVING');
    } finally {
      await harness.close();
    }
  });

  it('apagado ordenado: NOT_SERVING, termina la llamada en curso y después rechaza conexiones', async () => {
    const harness = await startGrpcHarness();
    const partId = await createPart(prisma, 10);

    // Otra transacción bloquea la pieza, así ReserveStock queda "en curso" durante el apagado.
    let releaseLock!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      void prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM parts WHERE id = ${partId}::uuid FOR UPDATE`;
        resolve();
        await new Promise<void>((done) => (releaseLock = done));
      }, { timeout: 20_000 });
    });
    await lockHeld;

    const inFlight = harness.call('ReserveStock', reserveRequest(randomUUID(), [[partId, 3]]));
    await new Promise((resolve) => setTimeout(resolve, 200));

    harness.app.get(HealthService).markShuttingDown();
    await expect(harness.healthCheck()).resolves.toBe('NOT_SERVING');

    let closed = false;
    const closing = harness.close().then(() => (closed = true));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(closed).toBe(false); // espera a la llamada en curso

    releaseLock();
    await expect(inFlight).resolves.toMatchObject({ replayed: false });
    await closing;
    expect(await stockOf(prisma, partId)).toBe(7);

    // Con el servidor cerrado, un cliente nuevo no puede conectarse.
    await expect(callListParts(harness.address)).rejects.toMatchObject({ code: grpc.status.UNAVAILABLE });
  });
});

function callListParts(address: string): Promise<unknown> {
  const definition = protoLoader.loadSync('../../contracts/grpc/repuestossur/inventory/v1/inventory.proto', {
    keepCase: true,
  });
  const client = new (grpc.loadPackageDefinition(definition) as any).repuestossur.inventory.v1.InventoryService(
    address,
    grpc.credentials.createInsecure(),
  );
  return new Promise((resolve, reject) => {
    client.ListParts({}, { deadline: Date.now() + 1_000 }, (error: grpc.ServiceError | null, response: unknown) => {
      client.close();
      error ? reject(error) : resolve(response);
    });
  });
}
