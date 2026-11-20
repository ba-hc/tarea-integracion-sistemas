import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { ApiError } from '../../src/common/api-error.js';
import { OrdersService } from '../../src/orders/orders.service.js';
import type { OrderCreateDto } from '../../src/orders/order.dto.js';
import { SaleSagaOrchestrator } from '../../src/saga/sale-saga.orchestrator.js';
import { FakeDispatch, FakePayments, TEST_PART_ID, TestInventory, testConfig } from './fakes.js';
import { resetDatabase, testDatabaseUrl } from './test-database.js';

// Regresión de la T1 sobre el flujo T2: idempotencia pública, rechazos de
// Inventory, respuestas ambiguas y cancelación. La Saga corre completa con
// Pagos y Despacho sanos; los escenarios propios de la Saga están en
// saga.integration.spec.ts.

let prisma!: PrismaService;
let inventory: TestInventory;
let payments: FakePayments;
let dispatch: FakeDispatch;
let orders: OrdersService;
let customerId: string;

function request(quantity = 1): OrderCreateDto {
  return { customerId, items: [{ partId: TEST_PART_ID, quantity }] };
}

describe('OrdersService with Sales PostgreSQL (T1 regression)', () => {
  beforeAll(() => {
    prisma = new PrismaService(testConfig(testDatabaseUrl()));
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    const config = testConfig(testDatabaseUrl());
    inventory = new TestInventory();
    payments = new FakePayments();
    dispatch = new FakeDispatch();
    orders = new OrdersService(prisma, inventory, new SaleSagaOrchestrator(prisma, inventory, payments, dispatch, config));
    const customer = await prisma.customer.create({ data: { name: 'Integration customer', email: `${randomUUID()}@test.example` } });
    customerId = customer.id;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('replays the original create response even after the order is cancelled', async () => {
    inventory.delayMs = 25;
    const key = 'same-order-key-001';
    const [first, concurrentReplay] = await Promise.all([
      orders.create(request(), key, 'trace-first'),
      orders.create(request(), key, 'trace-second'),
    ]);
    await orders.cancel(first.order.id, 'trace-cancel');
    const replay = await orders.create(request(), key, 'trace-replay');

    expect(first.order.id).toBe(concurrentReplay.order.id);
    expect(first.order.id).toBe(replay.order.id);
    expect([first.replayed, concurrentReplay.replayed].sort()).toEqual([false, true]);
    expect(inventory.reserveCalls).toBe(1);
    expect(payments.chargeCalls).toBe(1);
    expect(dispatch.createCalls).toBe(1);
    expect(inventory.releasedSuccessfully).toBe(1);
    expect(replay.replayed).toBe(true);
    expect(first.order.items).toEqual([{ partId: TEST_PART_ID, sku: 'SKU-3224288d', name: 'Integration snapshot', quantity: 1 }]);
    expect(replay.order.status).toBe('CONFIRMED');
    expect(replay.order.cancelledAt).toBeNull();
    expect(replay.order.updatedAt.getTime()).toBe(first.order.updatedAt.getTime());
    expect((await orders.get(first.order.id)).status).toBe('CANCELLED');
    expect(await prisma.order.count()).toBe(1);
  });

  it('rejects a different normalized payload for a used key without another reservation', async () => {
    const key = 'payload-conflict-001';
    await orders.create(request(1), key, 'trace-create');

    await expect(orders.create(request(2), key, 'trace-conflict')).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_CONFLICT',
      status: 409,
    });
    expect(inventory.reserveCalls).toBe(1);
    expect(payments.chargeCalls).toBe(1);
    expect(await prisma.order.count()).toBe(1);
  });

  it('returns 404 for an unknown customer without calling any service', async () => {
    const unknown = { customerId: randomUUID(), items: [{ partId: TEST_PART_ID, quantity: 1 }] };
    await expect(orders.create(unknown, 'unknown-customer-key', 'trace')).rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND', status: 404 });
    await expect(orders.create(unknown, 'unknown-customer-key', 'trace')).rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND' });
    expect(inventory.reserveCalls).toBe(0);
    expect(await prisma.saleSaga.count()).toBe(0);
  });

  it('does not persist a confirmed order when Inventory rejects a reservation', async () => {
    inventory.reserveFailure = new ApiError(409, 'INSUFFICIENT_STOCK', 'One or more parts do not have enough stock');

    await expect(orders.create(request(), 'stock-rejected-key', 'trace-stock')).rejects.toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      status: 409,
    });
    expect(await prisma.order.count()).toBe(0);
    expect(payments.chargeCalls).toBe(0);
    expect(inventory.releaseCalls).toBe(0);
    expect(await prisma.idempotencyRequest.findFirstOrThrow()).toMatchObject({ state: 'FAILED', responseStatus: 409 });
    expect(await prisma.saleSaga.findFirstOrThrow()).toMatchObject({ status: 'FAILED', stockStatus: 'REJECTED' });
  });

  it('retains an ambiguous timeout claim so a same-key retry resolves one stable order', async () => {
    inventory.reserveFailureAfterCommit = new ApiError(504, 'INVENTORY_TIMEOUT', 'Inventory service did not respond before the deadline');
    const key = 'ambiguous-timeout-key';

    await expect(orders.create(request(), key, 'trace-timeout')).rejects.toMatchObject({
      code: 'INVENTORY_TIMEOUT',
      status: 504,
    });
    expect(await prisma.order.count()).toBe(0);
    expect(inventory.stockOf()).toBe(4);
    expect(await prisma.saleSaga.findFirstOrThrow()).toMatchObject({ status: 'RUNNING', stockStatus: 'IN_DOUBT' });

    const recovered = await orders.create(request(), key, 'trace-retry');
    expect(recovered.order.status).toBe('CONFIRMED');
    expect(inventory.reserveCalls).toBe(2);
    expect(inventory.attemptedOrderIds[1]).toBe(inventory.attemptedOrderIds[0]);
    expect(await prisma.order.count()).toBe(1);
    expect(inventory.stockOf()).toBe(4);
  });

  it('retains a same-key claim when Inventory returns 500 after reserving stock', async () => {
    inventory.reserveFailureAfterCommit = new ApiError(500, 'INTERNAL_ERROR', 'Inventory response was lost');
    const key = 'ambiguous-internal-key';

    await expect(orders.create(request(), key, 'trace-internal')).rejects.toMatchObject({ code: 'INTERNAL_ERROR', status: 500 });
    expect(await prisma.idempotencyRequest.findUniqueOrThrow({ where: { key } })).toMatchObject({ state: 'IN_PROGRESS' });
    expect(inventory.stockOf()).toBe(4);

    const recovered = await orders.create(request(), key, 'trace-retry');
    expect(recovered.order.status).toBe('CONFIRMED');
    expect(inventory.reserveCalls).toBe(2);
    expect(inventory.stockOf()).toBe(4);
  });

  it('preserves a committed order when the database commit acknowledgment is lost', async () => {
    const originalTransaction = prisma.$transaction.bind(prisma);
    let calls = 0;
    const transactionSpy = vi.spyOn(prisma, '$transaction');
    transactionSpy.mockImplementation(((operation: unknown, options?: unknown) => {
      if (typeof operation !== 'function') throw new Error('Unexpected batch transaction in this test');
      calls += 1;
      // 1.ª transacción: claim de la key. 2.ª: finalización de la venta (se pierde su ACK).
      return originalTransaction(operation as never, options as never).then((result) => {
        if (calls !== 2) return result;
        throw new Error('injected lost commit acknowledgment');
      });
    }) as typeof prisma.$transaction);

    try {
      const created = await orders.create(request(), 'lost-commit-ack-key', 'trace-lost-ack');
      expect(created.order.status).toBe('CONFIRMED');
      expect(created.replayed).toBe(true);
      expect(inventory.reserveCalls).toBe(1);
      expect(inventory.releaseCalls).toBe(0);
      expect(payments.refundCalls).toBe(0);
      expect(await prisma.order.count()).toBe(1);
      expect(await prisma.idempotencyRequest.findUniqueOrThrow({ where: { key: 'lost-commit-ack-key' } }))
        .toMatchObject({ state: 'CONFIRMED', responseStatus: 201 });
    } finally {
      transactionSpy.mockRestore();
    }
  });

  it('retries only the local finalization after a Sales persistence failure, without compensating', async () => {
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_test_order_items ON "order_items"');
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS fail_test_order_item_insert()');
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION fail_test_order_item_insert() RETURNS trigger
      LANGUAGE plpgsql AS $failure$
      BEGIN
        RAISE EXCEPTION 'injected Sales persistence failure';
      END;
      $failure$
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER fail_test_order_items
      BEFORE INSERT ON "order_items"
      FOR EACH ROW EXECUTE FUNCTION fail_test_order_item_insert()
    `);

    try {
      await expect(orders.create(request(), 'local-db-failure-key', 'trace-db-failure')).rejects.toMatchObject({
        code: 'INTERNAL_ERROR',
        message: 'An unexpected internal error occurred',
      });
      expect(await prisma.order.count()).toBe(0);
      expect(await prisma.saleSaga.findFirstOrThrow()).toMatchObject({
        status: 'RUNNING',
        stockStatus: 'DONE',
        paymentStatus: 'DONE',
        dispatchStatus: 'DONE',
      });
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_test_order_items ON "order_items"');
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS fail_test_order_item_insert()');
    }

    const retried = await orders.create(request(), 'local-db-failure-key', 'trace-db-retry');
    expect(retried.order.status).toBe('CONFIRMED');
    expect(retried.replayed).toBe(false);
    expect(inventory.reserveCalls).toBe(1);
    expect(payments.chargeCalls).toBe(1);
    expect(dispatch.createCalls).toBe(1);
    expect(inventory.releaseCalls).toBe(0);
    expect(inventory.stockOf()).toBe(4);
  });

  it('leaves an order confirmed when release fails and releases only once after retry', async () => {
    const created = await orders.create(request(), 'cancel-order-key', 'trace-create');
    inventory.releaseFailure = new ApiError(503, 'INVENTORY_UNAVAILABLE', 'Inventory service is unavailable');

    await expect(orders.cancel(created.order.id, 'trace-cancel-fail')).rejects.toMatchObject({
      code: 'INVENTORY_UNAVAILABLE',
      status: 503,
    });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: created.order.id } })).status).toBe('CONFIRMED');

    inventory.releaseFailure = undefined;
    expect((await orders.cancel(created.order.id, 'trace-cancel')).status).toBe('CANCELLED');
    expect((await orders.cancel(created.order.id, 'trace-repeat')).status).toBe('CANCELLED');
    expect(inventory.releasedSuccessfully).toBe(1);
    expect(inventory.releaseCalls).toBe(2);
    // Despacho y pago se compensaron una sola vez aunque se reintentó la cancelación.
    expect(dispatch.cancelCalls).toBe(1);
    expect(payments.refundCalls).toBe(1);
  });

  it('completes cancellation on retry after the compensations succeeded but persistence failed', async () => {
    const created = await orders.create(request(), 'cancel-db-failure-key', 'trace-create');
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_test_cancel_update ON "orders"');
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS fail_test_cancel_update_once()');
    await prisma.$executeRawUnsafe('DROP SEQUENCE IF EXISTS fail_test_cancel_update_count');
    await prisma.$executeRawUnsafe('CREATE SEQUENCE fail_test_cancel_update_count');
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION fail_test_cancel_update_once() RETURNS trigger
      LANGUAGE plpgsql AS $failure$
      BEGIN
        IF nextval('fail_test_cancel_update_count') = 1 THEN
          RAISE EXCEPTION 'injected cancellation persistence failure';
        END IF;
        RETURN NEW;
      END;
      $failure$
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER fail_test_cancel_update
      BEFORE UPDATE ON "orders"
      FOR EACH ROW EXECUTE FUNCTION fail_test_cancel_update_once()
    `);

    try {
      await expect(orders.cancel(created.order.id, 'trace-cancel-db-failure')).rejects.toMatchObject({
        code: 'INTERNAL_ERROR',
        status: 500,
      });
      expect((await orders.get(created.order.id)).status).toBe('CONFIRMED');
      expect(inventory.stockOf()).toBe(5);

      expect((await orders.cancel(created.order.id, 'trace-cancel-retry')).status).toBe('CANCELLED');
      // Los pasos ya compensados no se vuelven a llamar al reintentar.
      expect(inventory.releaseCalls).toBe(1);
      expect(payments.refundCalls).toBe(1);
      expect(dispatch.cancelCalls).toBe(1);
      expect(inventory.stockOf()).toBe(5);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_test_cancel_update ON "orders"');
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS fail_test_cancel_update_once()');
      await prisma.$executeRawUnsafe('DROP SEQUENCE IF EXISTS fail_test_cancel_update_count');
    }
  });

  it('cancels an order created before the saga existed with the T1 release-only flow', async () => {
    const legacyId = randomUUID();
    await inventory.reserve(legacyId, [{ partId: TEST_PART_ID, quantity: 1 }]);
    await prisma.order.create({
      data: {
        id: legacyId,
        customerId,
        status: 'CONFIRMED',
        items: { create: [{ partId: TEST_PART_ID, partSkuSnapshot: 'SKU-legacy', partNameSnapshot: 'Legacy', quantity: 1 }] },
      },
    });

    expect((await orders.cancel(legacyId, 'trace-legacy')).status).toBe('CANCELLED');
    expect(inventory.stockOf()).toBe(5);
    expect(payments.refundCalls).toBe(0);
    expect(dispatch.cancelCalls).toBe(0);
  });
});
