import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SagaConfig } from '../../src/config/app-config.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { OrdersService } from '../../src/orders/orders.service.js';
import type { OrderCreateDto } from '../../src/orders/order.dto.js';
import { SaleSagaOrchestrator } from '../../src/saga/sale-saga.orchestrator.js';
import { SagaRecoveryWorker } from '../../src/saga/saga-recovery.worker.js';
import { FakeDispatch, FakePayments, TEST_PART_ID, TestInventory, testConfig, type CallLog } from './fakes.js';
import { resetDatabase, testDatabaseUrl } from './test-database.js';

// T2-303: escenarios de la Saga «vender un repuesto» contra PostgreSQL real.
// Inventory, Pagos y Despacho son dobles en memoria con la semántica
// idempotente de sus contratos; la bitácora `calls` registra el orden real de
// las llamadas entre servicios.

let prisma!: PrismaService;
let calls: CallLog;
let inventory: TestInventory;
let payments: FakePayments;
let dispatch: FakeDispatch;
let orders: OrdersService;
let worker: SagaRecoveryWorker;
let customerId: string;

function build(saga: Partial<SagaConfig> = {}): void {
  const config = testConfig(testDatabaseUrl(), saga);
  calls = [];
  inventory = new TestInventory(calls);
  payments = new FakePayments(calls);
  dispatch = new FakeDispatch(calls);
  const orchestrator = new SaleSagaOrchestrator(prisma, inventory, payments, dispatch, config);
  orders = new OrdersService(prisma, inventory, orchestrator);
  worker = new SagaRecoveryWorker(orchestrator, config);
}

function sale(quantity = 2): OrderCreateDto {
  return { customerId, items: [{ partId: TEST_PART_ID, quantity }] };
}

async function sagaOf(key: string) {
  return prisma.saleSaga.findUniqueOrThrow({ where: { idempotencyKey: key } });
}

async function eventsOf(key: string): Promise<string[]> {
  const saga = await sagaOf(key);
  const events = await prisma.saleSagaEvent.findMany({ where: { orderId: saga.orderId }, orderBy: { id: 'asc' } });
  return events.map((event) => `${event.step}:${event.action}:${event.outcome}`);
}

describe('Sale saga (T2-301/302/303)', () => {
  beforeAll(() => {
    prisma = new PrismaService(testConfig(testDatabaseUrl()));
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    build();
    const customer = await prisma.customer.create({ data: { name: 'Saga customer', email: `${randomUUID()}@test.example` } });
    customerId = customer.id;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  describe('escenario 1: camino feliz', () => {
    it('reserves, charges and dispatches once, then exposes a CONFIRMED order', async () => {
      const result = await orders.create(sale(2), 'happy-path-key-01', 'trace-happy');

      expect(result.order.status).toBe('CONFIRMED');
      expect(calls).toEqual(['inventory.reserve', 'payments.charge', 'dispatch.create']);
      expect(inventory.stockOf()).toBe(3);
      // Monto = 2 unidades × 10 000 CLP (precio unitario configurable).
      expect(payments.amounts.get(result.order.id)).toEqual({ amountMinor: 20_000, currency: 'CLP' });
      expect(payments.state.get(result.order.id)).toBe('CHARGED');
      expect(dispatch.items.get(result.order.id)).toEqual([{ partId: TEST_PART_ID, quantity: 2 }]);
      expect(await sagaOf('happy-path-key-01')).toMatchObject({
        orderId: result.order.id,
        status: 'COMPLETED',
        stockStatus: 'DONE',
        paymentStatus: 'DONE',
        dispatchStatus: 'DONE',
        amountMinor: 20_000n,
      });
      expect(await eventsOf('happy-path-key-01')).toEqual([
        'stock:EXECUTE:DONE',
        'payment:EXECUTE:DONE',
        'dispatch:EXECUTE:DONE',
        'sale:COMPLETE:DONE',
      ]);
    });

    it('never charges twice for retries, even concurrent ones with the same key', async () => {
      inventory.delayMs = 30;
      const results = await Promise.all(Array.from({ length: 5 }, (_, index) => orders.create(sale(1), 'same-sale-key-01', `trace-${index}`)));
      const again = await orders.create(sale(1), 'same-sale-key-01', 'trace-later');

      expect(new Set([...results, again].map((result) => result.order.id)).size).toBe(1);
      expect(results.filter((result) => !result.replayed)).toHaveLength(1);
      expect(again.replayed).toBe(true);
      expect(inventory.reserveCalls).toBe(1);
      expect(payments.chargeCalls).toBe(1);
      expect(dispatch.createCalls).toBe(1);
      expect(inventory.stockOf()).toBe(4);
    });

    it('runs only the configured steps (SAGA_STEPS=stock keeps the T1 behaviour)', async () => {
      build({ steps: ['stock'] });
      const result = await orders.create(sale(1), 'stock-only-key-01', 'trace');
      expect(result.order.status).toBe('CONFIRMED');
      expect(calls).toEqual(['inventory.reserve']);
      expect(await sagaOf('stock-only-key-01')).toMatchObject({ paymentStatus: 'SKIPPED', dispatchStatus: 'SKIPPED' });

      await orders.cancel(result.order.id, 'trace-cancel');
      expect(calls).toEqual(['inventory.reserve', 'inventory.release']);
    });
  });

  describe('escenario 2: falla el último paso (Despacho) y se compensa en orden inverso', () => {
    it('refunds and then releases stock, leaving no order, charge or reservation', async () => {
      dispatch.createMode = 'reject';

      await expect(orders.create(sale(2), 'dispatch-fails-key', 'trace-dispatch')).rejects.toMatchObject({
        code: 'DISPATCH_UNAVAILABLE',
        status: 503,
      });

      expect(calls).toEqual(['inventory.reserve', 'payments.charge', 'dispatch.create', 'payments.refund', 'inventory.release']);
      const saga = await sagaOf('dispatch-fails-key');
      expect(saga).toMatchObject({
        status: 'FAILED',
        stockStatus: 'COMPENSATED',
        paymentStatus: 'COMPENSATED',
        dispatchStatus: 'REJECTED',
        failureCode: 'DISPATCH_UNAVAILABLE',
      });
      expect(payments.state.get(saga.orderId)).toBe('REFUNDED');
      expect(inventory.stockOf()).toBe(5);
      expect(await prisma.order.count()).toBe(0);
      expect(await prisma.idempotencyRequest.findUniqueOrThrow({ where: { key: 'dispatch-fails-key' } }))
        .toMatchObject({ state: 'FAILED', responseStatus: 503 });
      expect(await eventsOf('dispatch-fails-key')).toEqual([
        'stock:EXECUTE:DONE',
        'payment:EXECUTE:DONE',
        'dispatch:EXECUTE:REJECTED',
        'payment:COMPENSATE:COMPENSATED',
        'stock:COMPENSATE:COMPENSATED',
        'sale:FAIL:COMPENSATED',
      ]);
    });

    it('replays the same failure for a same-key retry without touching any service again', async () => {
      dispatch.createMode = 'reject';
      await expect(orders.create(sale(1), 'dispatch-fails-retry', 'trace-1')).rejects.toMatchObject({ code: 'DISPATCH_UNAVAILABLE' });
      const callsAfterFailure = calls.length;
      dispatch.createMode = 'ok';

      await expect(orders.create(sale(1), 'dispatch-fails-retry', 'trace-2')).rejects.toMatchObject({ code: 'DISPATCH_UNAVAILABLE', status: 503 });
      expect(calls).toHaveLength(callsAfterFailure);
    });

    it('keeps strict reverse order: stock is not released while the refund is pending, the recovery finishes later', async () => {
      dispatch.createMode = 'reject';
      payments.refundMode = 'unavailable';

      await expect(orders.create(sale(2), 'refund-pending-key', 'trace')).rejects.toMatchObject({ code: 'DISPATCH_UNAVAILABLE' });
      expect(calls).toEqual(['inventory.reserve', 'payments.charge', 'dispatch.create', 'payments.refund']);
      expect(inventory.stockOf()).toBe(3);
      const pending = await sagaOf('refund-pending-key');
      expect(pending).toMatchObject({
        status: 'COMPENSATING',
        paymentStatus: 'DONE',
        stockStatus: 'DONE',
        compensationAttempts: 1,
        lastErrorCode: 'PAYMENT_UNAVAILABLE',
      });
      expect(pending.nextAttemptAt).not.toBeNull();

      // Pagos se recupera; el recuperador retoma la compensación pendiente tras el backoff.
      payments.refundMode = 'ok';
      await delay(150);
      expect(await worker.tick()).toBe(1);

      expect(calls.slice(4)).toEqual(['payments.refund', 'inventory.release']);
      expect(inventory.stockOf()).toBe(5);
      expect(payments.state.get(pending.orderId)).toBe('REFUNDED');
      expect(await sagaOf('refund-pending-key')).toMatchObject({ status: 'FAILED', paymentStatus: 'COMPENSATED', stockStatus: 'COMPENSATED' });
      expect(await prisma.idempotencyRequest.findUniqueOrThrow({ where: { key: 'refund-pending-key' } })).toMatchObject({ state: 'FAILED' });
      expect(await eventsOf('refund-pending-key')).toEqual([
        'stock:EXECUTE:DONE',
        'payment:EXECUTE:DONE',
        'dispatch:EXECUTE:REJECTED',
        'payment:COMPENSATE:RETRY',
        'payment:COMPENSATE:COMPENSATED',
        'stock:COMPENSATE:COMPENSATED',
        'sale:FAIL:COMPENSATED',
      ]);
    });
  });

  describe('fallas de Pagos', () => {
    it('a declined payment releases the stock and never dispatches', async () => {
      payments.chargeMode = 'decline';
      await expect(orders.create(sale(1), 'declined-payment-key', 'trace')).rejects.toMatchObject({ code: 'PAYMENT_DECLINED', status: 422 });
      expect(calls).toEqual(['inventory.reserve', 'payments.charge', 'inventory.release']);
      expect(inventory.stockOf()).toBe(5);
      expect(await sagaOf('declined-payment-key')).toMatchObject({ status: 'FAILED', paymentStatus: 'REJECTED', stockStatus: 'COMPENSATED' });
    });

    it('a fail-fast rejection from Payments (circuit open) releases the stock immediately', async () => {
      payments.chargeMode = 'reject';
      await expect(orders.create(sale(1), 'payments-open-key', 'trace')).rejects.toMatchObject({ code: 'PAYMENT_UNAVAILABLE', status: 503 });
      expect(calls).toEqual(['inventory.reserve', 'payments.charge', 'inventory.release']);
      expect(inventory.stockOf()).toBe(5);
    });

    it('a payment timeout leaves the step in doubt; a same-key retry completes the sale with a single charge', async () => {
      payments.chargeMode = 'timeout-after-charge';
      await expect(orders.create(sale(1), 'payment-timeout-key', 'trace-1')).rejects.toMatchObject({ code: 'PAYMENT_TIMEOUT', status: 504 });
      expect(await sagaOf('payment-timeout-key')).toMatchObject({ status: 'RUNNING', stockStatus: 'DONE', paymentStatus: 'IN_DOUBT' });
      expect(await prisma.order.count()).toBe(0);
      expect(inventory.stockOf()).toBe(4);

      payments.chargeMode = 'ok';
      const result = await orders.create(sale(1), 'payment-timeout-key', 'trace-2');
      expect(result.order.status).toBe('CONFIRMED');
      expect(payments.chargeCalls).toBe(2);
      expect(payments.effectiveCharges.get(result.order.id)).toBe(1);
      expect(inventory.reserveCalls).toBe(1);
    });

    it('without a retry, the recovery aborts the stalled sale: refund (in doubt) and release in reverse order', async () => {
      payments.chargeMode = 'timeout-after-charge';
      await expect(orders.create(sale(1), 'payment-stalled-key', 'trace-1')).rejects.toMatchObject({ code: 'PAYMENT_TIMEOUT' });

      expect(await worker.tick()).toBe(0); // todavía dentro del plazo de reintento
      await delay(150);
      expect(await worker.tick()).toBe(1);

      const saga = await sagaOf('payment-stalled-key');
      expect(saga).toMatchObject({ status: 'FAILED', paymentStatus: 'COMPENSATED', stockStatus: 'COMPENSATED', failureCode: 'PAYMENT_TIMEOUT' });
      expect(payments.state.get(saga.orderId)).toBe('REFUNDED');
      expect(inventory.stockOf()).toBe(5);
      expect(calls).toEqual(['inventory.reserve', 'payments.charge', 'payments.refund', 'inventory.release']);
      expect(await eventsOf('payment-stalled-key')).toEqual([
        'stock:EXECUTE:DONE',
        'payment:EXECUTE:IN_DOUBT',
        'sale:ABORT:STALLED',
        'payment:COMPENSATE:COMPENSATED',
        'stock:COMPENSATE:COMPENSATED',
        'sale:FAIL:COMPENSATED',
      ]);

      // El cliente que reintenta tarde recibe el mismo resultado, sin un cobro nuevo.
      await expect(orders.create(sale(1), 'payment-stalled-key', 'trace-late')).rejects.toMatchObject({ code: 'PAYMENT_TIMEOUT', status: 504 });
      expect(payments.chargeCalls).toBe(1);
    });

    it('an in-doubt charge that never reached the gateway is compensated as "nothing to refund"', async () => {
      payments.chargeMode = 'timeout-before-charge';
      await expect(orders.create(sale(1), 'charge-never-applied', 'trace')).rejects.toMatchObject({ code: 'PAYMENT_TIMEOUT' });
      await delay(150);
      await worker.tick();
      const saga = await sagaOf('charge-never-applied');
      expect(saga).toMatchObject({ status: 'FAILED', paymentStatus: 'COMPENSATED' });
      expect(payments.effectiveCharges.get(saga.orderId)).toBeUndefined();
      expect(inventory.stockOf()).toBe(5);
    });
  });

  describe('Despacho en duda', () => {
    it('aborts a dispatch timeout with cancel → refund → release', async () => {
      dispatch.createMode = 'timeout-before-create';
      await expect(orders.create(sale(1), 'dispatch-timeout-key', 'trace')).rejects.toMatchObject({ code: 'DISPATCH_TIMEOUT', status: 504 });
      await delay(150);
      await worker.tick();
      expect(calls).toEqual([
        'inventory.reserve',
        'payments.charge',
        'dispatch.create',
        'dispatch.cancel',
        'payments.refund',
        'inventory.release',
      ]);
      expect(await sagaOf('dispatch-timeout-key')).toMatchObject({ status: 'FAILED', dispatchStatus: 'COMPENSATED' });
      expect(inventory.stockOf()).toBe(5);
    });
  });

  describe('cancelación de una venta confirmada', () => {
    it('cancels dispatch, refunds and releases stock in that order before marking the order CANCELLED', async () => {
      const created = await orders.create(sale(2), 'cancel-sale-key', 'trace');
      calls.length = 0;

      const cancelled = await orders.cancel(created.order.id, 'trace-cancel');
      expect(cancelled.status).toBe('CANCELLED');
      expect(calls).toEqual(['dispatch.cancel', 'payments.refund', 'inventory.release']);
      expect(dispatch.state.get(created.order.id)).toBe('CANCELLED');
      expect(payments.state.get(created.order.id)).toBe('REFUNDED');
      expect(inventory.stockOf()).toBe(5);
      expect(await sagaOf('cancel-sale-key')).toMatchObject({ status: 'CANCELLED' });

      expect((await orders.cancel(created.order.id, 'trace-again')).status).toBe('CANCELLED');
      expect(calls).toHaveLength(3);
    });

    it('keeps the order CONFIRMED while a compensation is pending and the recovery completes the cancellation', async () => {
      const created = await orders.create(sale(1), 'cancel-pending-key', 'trace');
      payments.refundMode = 'unavailable';

      await expect(orders.cancel(created.order.id, 'trace-cancel')).rejects.toMatchObject({ code: 'PAYMENT_UNAVAILABLE', status: 503 });
      expect((await orders.get(created.order.id)).status).toBe('CONFIRMED');
      expect(inventory.stockOf()).toBe(4);
      expect(await sagaOf('cancel-pending-key')).toMatchObject({ status: 'CANCELLING', dispatchStatus: 'COMPENSATED', paymentStatus: 'DONE' });

      payments.refundMode = 'ok';
      await delay(150);
      await worker.tick();
      expect((await orders.get(created.order.id)).status).toBe('CANCELLED');
      expect(inventory.stockOf()).toBe(5);
      expect(dispatch.cancelCalls).toBe(1);
    });
  });
});
