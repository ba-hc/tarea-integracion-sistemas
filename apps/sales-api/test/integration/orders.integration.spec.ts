import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { ApiError } from '../../src/common/api-error.js';
import type { SalesConfig } from '../../src/config/app-config.js';
import type { InventoryGateway, PartSnapshot, ReservedStockItem } from '../../src/inventory/inventory.gateway.js';
import { OrdersService } from '../../src/orders/orders.service.js';
import type { OrderCreateDto } from '../../src/orders/order.dto.js';
import { resetDatabase, testDatabaseUrl } from './test-database.js';

const TEST_PART_ID = '3224288d-5201-477a-aa99-cb7cd1ba628d';

const config: SalesConfig = {
  host: '127.0.0.1',
  port: 3000,
  databaseUrl: '',
  apiKeyReader: 'reader-test',
  apiKeyOperator: 'operator-test',
  inventoryGrpcUrl: 'localhost:50051',
  inventoryRpcDeadlineMs: 800,
  inventoryProtoPath: '/contract/inventory.proto',
};

class TestInventory implements InventoryGateway {
  reserveCalls = 0;
  releaseCalls = 0;
  releasedSuccessfully = 0;
  attemptedOrderIds: string[] = [];
  delayMs = 0;
  reserveFailure: ApiError | undefined;
  reserveFailureAfterCommit: ApiError | undefined;
  releaseFailure: ApiError | undefined;
  private readonly availableStock = new Map<string, number>([[TEST_PART_ID, 5]]);
  private readonly reservations = new Map<string, ReservedStockItem[]>();

  private releaseGate: { entered: () => void; enteredPromise: Promise<void>; wait: Promise<void>; unblock: () => void } | undefined;

  blockNextRelease(): { entered: Promise<void>; unblock: () => void } {
    let entered!: () => void;
    let unblock!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const wait = new Promise<void>((resolve) => { unblock = resolve; });
    this.releaseGate = { entered, enteredPromise, wait, unblock };
    return { entered: enteredPromise, unblock };
  }

  async reserve(
    orderId: string,
    items: Array<{ partId: string; quantity: number }>,
    _traceId: string,
  ): Promise<ReservedStockItem[]> {
    this.reserveCalls += 1;
    this.attemptedOrderIds.push(orderId);
    if (this.delayMs) await delay(this.delayMs);
    if (this.reserveFailure) throw this.reserveFailure;
    const existing = this.reservations.get(orderId);
    if (existing) return existing;

    for (const item of items) {
      const available = this.availableStock.get(item.partId);
      if (available === undefined) throw new ApiError(422, 'PART_NOT_FOUND', 'Part not found');
      if (available < item.quantity) throw new ApiError(409, 'INSUFFICIENT_STOCK', 'One or more parts do not have enough stock');
    }

    const snapshots = items.map((item) => ({
      partId: item.partId,
      sku: `SKU-${item.partId.slice(0, 8)}`,
      name: 'Integration snapshot',
      quantity: item.quantity,
    }));
    for (const item of items) {
      this.availableStock.set(item.partId, this.availableStock.get(item.partId)! - item.quantity);
    }
    this.reservations.set(orderId, snapshots);
    if (this.reserveFailureAfterCommit) {
      const error = this.reserveFailureAfterCommit;
      this.reserveFailureAfterCommit = undefined;
      throw error;
    }
    return snapshots;
  }

  async release(orderId: string, _traceId: string): Promise<void> {
    const gate = this.releaseGate;
    if (gate) {
      this.releaseGate = undefined;
      gate.entered();
      await gate.wait;
    }
    this.releaseCalls += 1;
    if (this.releaseFailure) throw this.releaseFailure;
    const reservation = this.reservations.get(orderId);
    if (reservation) {
      this.reservations.delete(orderId);
      for (const item of reservation) {
        this.availableStock.set(item.partId, this.availableStock.get(item.partId)! + item.quantity);
      }
      this.releasedSuccessfully += 1;
    }
  }

  async getPart(partId: string, _traceId: string): Promise<PartSnapshot> {
    const stockAvailable = this.availableStock.get(partId);
    if (stockAvailable === undefined) throw new ApiError(422, 'PART_NOT_FOUND', 'Part not found');
    return { partId, sku: `SKU-${partId.slice(0, 8)}`, name: 'Integration snapshot', stockAvailable };
  }

  async listParts(_traceId: string): Promise<PartSnapshot[]> {
    return [...this.availableStock].map(([partId, stockAvailable]) => ({
      partId,
      sku: `SKU-${partId.slice(0, 8)}`,
      name: 'Integration snapshot',
      stockAvailable,
    }));
  }
  reset(): void {
    this.reserveCalls = 0;
    this.releaseCalls = 0;
    this.releasedSuccessfully = 0;
    this.delayMs = 0;
    this.reserveFailure = undefined;
    this.releaseFailure = undefined;
    this.attemptedOrderIds = [];
    this.reserveFailureAfterCommit = undefined;
    this.releaseGate?.unblock();
    this.releaseGate = undefined;
    this.availableStock.clear();
    this.availableStock.set(TEST_PART_ID, 5);
    this.reservations.clear();
  }
}

let prisma!: PrismaService;
let gateway: TestInventory;
let orders: OrdersService;
let customerId: string;

function request(quantity = 1): OrderCreateDto {
  return {
    customerId,
    items: [{ partId: TEST_PART_ID, quantity }],
  };
}

async function waitForIdempotencyLockWait(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const waiting = await prisma.$queryRaw<Array<{ pid: number }>>`
      SELECT pid
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND query ILIKE '%idempotency_requests%'
    `;
    if (waiting.length > 0) return;
    await delay(10);
  }
  throw new Error('Timed out waiting for a same-key request to block on the idempotency lock');
}

describe('OrdersService with Sales PostgreSQL', () => {
  beforeAll(async () => {
    const testConfig = { ...config, databaseUrl: testDatabaseUrl() };
    prisma = new PrismaService(testConfig);
    gateway = new TestInventory();
    orders = new OrdersService(prisma, gateway, testConfig);
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    gateway.reset();
    const customer = await prisma.customer.create({ data: { name: 'Integration customer', email: `${randomUUID()}@test.example` } });
    customerId = customer.id;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('replays the original create response even after the order is cancelled', async () => {
    gateway.delayMs = 25;
    const key = 'same-order-key-001';
    const [first, concurrentReplay] = await Promise.all([
      orders.create(request(), key, 'trace-first'),
      orders.create(request(), key, 'trace-second'),
    ]);
    await orders.cancel(first.order.id, 'trace-cancel');
    const replay = await orders.create(request(), key, 'trace-replay');

    expect(first.order.id).toBe(concurrentReplay.order.id);
    expect(first.order.id).toBe(replay.order.id);
    expect(gateway.reserveCalls).toBe(1);
    expect(gateway.releaseCalls).toBe(1);
    expect(gateway.releasedSuccessfully).toBe(1);
    expect(replay.replayed).toBe(true);
    expect(first.order.items).toEqual([{
      partId: '3224288d-5201-477a-aa99-cb7cd1ba628d',
      sku: 'SKU-3224288d',
      name: 'Integration snapshot',
      quantity: 1,
    }]);
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
    expect(gateway.reserveCalls).toBe(1);
    expect(await prisma.order.count()).toBe(1);
  });

  it('does not persist a confirmed order when Inventory rejects a reservation', async () => {
    gateway.reserveFailure = new ApiError(409, 'INSUFFICIENT_STOCK', 'One or more parts do not have enough stock');

    await expect(orders.create(request(), 'stock-rejected-key', 'trace-stock')).rejects.toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      status: 409,
    });
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.idempotencyRequest.findFirstOrThrow()).toMatchObject({ state: 'FAILED', responseStatus: 409 });
  });

  it('retains an ambiguous timeout claim so a same-key retry resolves one stable order', async () => {
    gateway.reserveFailureAfterCommit = new ApiError(504, 'INVENTORY_TIMEOUT', 'Inventory service did not respond before the deadline');
    const key = 'ambiguous-timeout-key';

    await expect(orders.create(request(), key, 'trace-timeout')).rejects.toMatchObject({
      code: 'INVENTORY_TIMEOUT',
      status: 504,
    });
    expect(await prisma.order.count()).toBe(0);
    expect((await gateway.getPart(TEST_PART_ID, 'trace-stock')).stockAvailable).toBe(4);

    const recovered = await orders.create(request(), key, 'trace-retry');
    expect(recovered.order.status).toBe('CONFIRMED');
    expect(gateway.reserveCalls).toBe(2);
    expect(gateway.attemptedOrderIds[1]).toBe(gateway.attemptedOrderIds[0]);
    expect(await prisma.order.count()).toBe(1);
    expect((await gateway.getPart(TEST_PART_ID, 'trace-stock')).stockAvailable).toBe(4);
  });

  it('retains a same-key claim when Inventory returns 500 after reserving stock', async () => {
    gateway.reserveFailureAfterCommit = new ApiError(500, 'INTERNAL_ERROR', 'Inventory response was lost');
    const key = 'ambiguous-internal-key';

    await expect(orders.create(request(), key, 'trace-internal')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      status: 500,
    });
    expect(await prisma.idempotencyRequest.findUniqueOrThrow({ where: { key } })).toMatchObject({ state: 'IN_PROGRESS' });
    expect((await gateway.getPart(TEST_PART_ID, 'trace-stock')).stockAvailable).toBe(4);

    const recovered = await orders.create(request(), key, 'trace-retry');
    expect(recovered.order.status).toBe('CONFIRMED');
    expect(gateway.reserveCalls).toBe(2);
    expect(gateway.attemptedOrderIds[1]).toBe(gateway.attemptedOrderIds[0]);
    expect((await gateway.getPart(TEST_PART_ID, 'trace-stock')).stockAvailable).toBe(4);
  });

  it('preserves a committed order when the database commit acknowledgment is lost', async () => {
    const originalTransaction = prisma.$transaction.bind(prisma);
    let loseAcknowledgment = true;
    const transactionSpy = vi.spyOn(prisma, '$transaction');
    transactionSpy.mockImplementation(((operation: unknown, options?: unknown) => {
      if (typeof operation !== 'function') throw new Error('Unexpected batch transaction in this test');
      return originalTransaction(operation as never, options as never).then((result) => {
        if (!loseAcknowledgment) return result;
        loseAcknowledgment = false;
        throw new Error('injected lost commit acknowledgment');
      });
    }) as typeof prisma.$transaction);

    try {
      const created = await orders.create(request(), 'lost-commit-ack-key', 'trace-lost-ack');
      expect(created.order.status).toBe('CONFIRMED');
      expect(created.replayed).toBe(true);
      expect(gateway.reserveCalls).toBe(1);
      expect(gateway.releaseCalls).toBe(0);
      expect(await prisma.order.count()).toBe(1);
      expect(await prisma.idempotencyRequest.findUniqueOrThrow({ where: { key: 'lost-commit-ack-key' } }))
        .toMatchObject({ state: 'CONFIRMED', responseStatus: 201 });
    } finally {
      transactionSpy.mockRestore();
    }
  });

  it('serializes persisted compensation with same-key retries after local order persistence fails', async () => {
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
    const releaseGate = gateway.blockNextRelease();

    try {
      const first = orders.create(request(), 'local-db-failure-key', 'trace-db-failure');
      await releaseGate.entered;
      const retry = orders.create(request(), 'local-db-failure-key', 'trace-db-retry');
      await waitForIdempotencyLockWait();
      releaseGate.unblock();
      await expect(first).rejects.toMatchObject({
        code: 'INTERNAL_ERROR',
        message: 'An unexpected internal error occurred',
      });
      await expect(retry).rejects.toMatchObject({
        code: 'INTERNAL_ERROR',
        message: 'An unexpected internal error occurred',
      });
    } finally {
      releaseGate.unblock();
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_test_order_items ON "order_items"');
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS fail_test_order_item_insert()');
    }

    expect(gateway.reserveCalls).toBe(1);
    expect(gateway.releasedSuccessfully).toBe(1);
    expect(gateway.releaseCalls).toBe(1);
    expect((await gateway.getPart(TEST_PART_ID, 'trace-stock')).stockAvailable).toBe(5);
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.idempotencyRequest.findFirstOrThrow()).toMatchObject({ state: 'FAILED', responseStatus: 500 });
  });

  it('leaves an order confirmed when release fails and releases only once after retry', async () => {
    const created = await orders.create(request(), 'cancel-order-key', 'trace-create');
    gateway.releaseFailure = new ApiError(503, 'INVENTORY_UNAVAILABLE', 'Inventory service is unavailable');

    await expect(orders.cancel(created.order.id, 'trace-cancel-fail')).rejects.toMatchObject({
      code: 'INVENTORY_UNAVAILABLE',
      status: 503,
    });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: created.order.id } })).status).toBe('CONFIRMED');

    gateway.releaseFailure = undefined;
    expect((await orders.cancel(created.order.id, 'trace-cancel')).status).toBe('CANCELLED');
    expect((await orders.cancel(created.order.id, 'trace-repeat')).status).toBe('CANCELLED');
    expect(gateway.releasedSuccessfully).toBe(1);
    expect(gateway.releaseCalls).toBe(2);
  });

  it('completes cancellation on retry after release succeeded but persistence failed', async () => {
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
      expect((await gateway.getPart(TEST_PART_ID, 'trace-stock')).stockAvailable).toBe(5);

      expect((await orders.cancel(created.order.id, 'trace-cancel-retry')).status).toBe('CANCELLED');
      expect(gateway.releaseCalls).toBe(2);
      expect(gateway.releasedSuccessfully).toBe(1);
      expect((await gateway.getPart(TEST_PART_ID, 'trace-stock')).stockAvailable).toBe(5);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_test_cancel_update ON "orders"');
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS fail_test_cancel_update_once()');
      await prisma.$executeRawUnsafe('DROP SEQUENCE IF EXISTS fail_test_cancel_update_count');
    }
  });
});