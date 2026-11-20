import { setTimeout as delay } from 'node:timers/promises';
import { ApiError } from '../../src/common/api-error.js';
import type { SagaConfig, SalesConfig } from '../../src/config/app-config.js';
import type { InventoryGateway, PartSnapshot, ReservedStockItem } from '../../src/inventory/inventory.gateway.js';
import type { DispatchGateway } from '../../src/saga/dispatch.client.js';
import type { PaymentsGateway } from '../../src/saga/payments.client.js';
import type { CompensationOutcome, StepOutcome } from '../../src/saga/saga-outcome.js';

export const TEST_PART_ID = '3224288d-5201-477a-aa99-cb7cd1ba628d';

/** Bitácora compartida: permite verificar el orden real de las llamadas entre servicios. */
export type CallLog = string[];

export function testSagaConfig(overrides: Partial<SagaConfig> = {}): SagaConfig {
  return {
    steps: ['stock', 'payment', 'dispatch'],
    paymentsBaseUrl: 'http://payments.test',
    paymentsTimeoutMs: 2_000,
    dispatchBaseUrl: 'http://dispatch.test',
    dispatchTimeoutMs: 1_500,
    unitPriceMinor: 10_000,
    currency: 'CLP',
    leaseMs: 5_000,
    abortAfterMs: 100,
    recoveryEnabled: false,
    recoveryIntervalMs: 100,
    maxBackoffMs: 1_000,
    ...overrides,
  };
}

export function testConfig(databaseUrl: string, saga: Partial<SagaConfig> = {}): SalesConfig {
  return {
    host: '127.0.0.1',
    port: 3000,
    databaseUrl,
    apiKeyReader: 'reader-test',
    apiKeyOperator: 'operator-test',
    inventoryGrpcUrl: 'localhost:50051',
    inventoryRpcDeadlineMs: 800,
    inventoryProtoPath: '/contract/inventory.proto',
    saga: testSagaConfig(saga),
  };
}

/** Inventario en memoria con la semántica idempotente por `order_id` del contrato gRPC. */
export class TestInventory implements InventoryGateway {
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
  private readonly released = new Set<string>();

  constructor(private readonly log: CallLog = []) {}

  stockOf(partId = TEST_PART_ID): number {
    return this.availableStock.get(partId) ?? 0;
  }

  async reserve(orderId: string, items: Array<{ partId: string; quantity: number }>): Promise<ReservedStockItem[]> {
    this.reserveCalls += 1;
    this.attemptedOrderIds.push(orderId);
    this.log.push('inventory.reserve');
    if (this.delayMs) await delay(this.delayMs);
    if (this.reserveFailure) throw this.reserveFailure;
    const existing = this.reservations.get(orderId);
    if (existing) return existing;
    if (this.released.has(orderId)) throw new ApiError(409, 'INSUFFICIENT_STOCK', 'One or more parts do not have enough stock');

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
    for (const item of items) this.availableStock.set(item.partId, this.availableStock.get(item.partId)! - item.quantity);
    this.reservations.set(orderId, snapshots);
    if (this.reserveFailureAfterCommit) {
      const error = this.reserveFailureAfterCommit;
      this.reserveFailureAfterCommit = undefined;
      throw error;
    }
    return snapshots;
  }

  async release(orderId: string): Promise<void> {
    const result = await this.releaseForCompensation(orderId);
    if (result === 'NO_RESERVATION') throw new ApiError(500, 'INTERNAL_ERROR', 'An unexpected internal error occurred');
  }

  async releaseForCompensation(orderId: string): Promise<'RELEASED' | 'NO_RESERVATION'> {
    this.releaseCalls += 1;
    this.log.push('inventory.release');
    if (this.releaseFailure) throw this.releaseFailure;
    if (this.released.has(orderId)) return 'RELEASED';
    const reservation = this.reservations.get(orderId);
    if (!reservation) return 'NO_RESERVATION';
    this.reservations.delete(orderId);
    this.released.add(orderId);
    for (const item of reservation) this.availableStock.set(item.partId, this.availableStock.get(item.partId)! + item.quantity);
    this.releasedSuccessfully += 1;
    return 'RELEASED';
  }

  async getPart(partId: string): Promise<PartSnapshot> {
    const stockAvailable = this.availableStock.get(partId);
    if (stockAvailable === undefined) throw new ApiError(422, 'PART_NOT_FOUND', 'Part not found');
    return { partId, sku: `SKU-${partId.slice(0, 8)}`, name: 'Integration snapshot', stockAvailable };
  }

  async listParts(): Promise<PartSnapshot[]> {
    return [...this.availableStock].map(([partId, stockAvailable]) => ({
      partId,
      sku: `SKU-${partId.slice(0, 8)}`,
      name: 'Integration snapshot',
      stockAvailable,
    }));
  }
}

type ChargeMode = 'ok' | 'decline' | 'reject' | 'timeout-after-charge' | 'timeout-before-charge';
type RefundMode = 'ok' | 'unavailable';

/** Pagos en memoria: un cobro por `orderId`, cobro y reembolso idempotentes. */
export class FakePayments implements PaymentsGateway {
  chargeMode: ChargeMode = 'ok';
  refundMode: RefundMode = 'ok';
  chargeCalls = 0;
  refundCalls = 0;
  /** Cobros efectivamente aplicados a la «tarjeta» (debe ser como máximo 1 por venta). */
  readonly effectiveCharges = new Map<string, number>();
  readonly amounts = new Map<string, { amountMinor: number; currency: string }>();
  readonly state = new Map<string, 'CHARGED' | 'DECLINED' | 'REFUNDED'>();

  constructor(private readonly log: CallLog = []) {}

  async charge(orderId: string, amountMinor: number, currency: string): Promise<StepOutcome> {
    this.chargeCalls += 1;
    this.log.push('payments.charge');
    const current = this.state.get(orderId);
    if (current === 'CHARGED') return { kind: 'done', value: undefined };
    if (current === 'DECLINED') return { kind: 'rejected', error: new ApiError(422, 'PAYMENT_DECLINED', 'The payment was declined') };
    switch (this.chargeMode) {
      case 'decline':
        this.state.set(orderId, 'DECLINED');
        return { kind: 'rejected', error: new ApiError(422, 'PAYMENT_DECLINED', 'The payment was declined') };
      case 'reject':
        return { kind: 'rejected', error: new ApiError(503, 'PAYMENT_UNAVAILABLE', 'Payment service is unavailable') };
      case 'timeout-before-charge':
        return { kind: 'in_doubt', error: new ApiError(504, 'PAYMENT_TIMEOUT', 'Payment service did not respond before the deadline') };
      case 'timeout-after-charge':
        this.apply(orderId, amountMinor, currency);
        return { kind: 'in_doubt', error: new ApiError(504, 'PAYMENT_TIMEOUT', 'Payment service did not respond before the deadline') };
      case 'ok':
        this.apply(orderId, amountMinor, currency);
        return { kind: 'done', value: undefined };
    }
  }

  async refund(orderId: string, wasInDoubt: boolean): Promise<CompensationOutcome> {
    this.refundCalls += 1;
    this.log.push('payments.refund');
    if (this.refundMode === 'unavailable') {
      return { kind: 'retry', error: new ApiError(503, 'PAYMENT_UNAVAILABLE', 'Payment service is unavailable') };
    }
    const current = this.state.get(orderId);
    if (current === undefined) return wasInDoubt ? { kind: 'compensated' } : { kind: 'retry', error: new ApiError(500, 'INTERNAL_ERROR', 'x') };
    if (current === 'CHARGED') this.state.set(orderId, 'REFUNDED');
    return { kind: 'compensated' };
  }

  private apply(orderId: string, amountMinor: number, currency: string): void {
    this.state.set(orderId, 'CHARGED');
    this.amounts.set(orderId, { amountMinor, currency });
    this.effectiveCharges.set(orderId, (this.effectiveCharges.get(orderId) ?? 0) + 1);
  }
}

type CreateMode = 'ok' | 'reject' | 'timeout-before-create';
type CancelMode = 'ok' | 'unavailable';

/** Despacho en memoria con la semántica de apps/dispatch-api. */
export class FakeDispatch implements DispatchGateway {
  createMode: CreateMode = 'ok';
  cancelMode: CancelMode = 'ok';
  createCalls = 0;
  cancelCalls = 0;
  readonly state = new Map<string, 'CREATED' | 'CANCELLED'>();
  readonly items = new Map<string, Array<{ partId: string; quantity: number }>>();

  constructor(private readonly log: CallLog = []) {}

  async create(orderId: string, items: Array<{ partId: string; quantity: number }>): Promise<StepOutcome> {
    this.createCalls += 1;
    this.log.push('dispatch.create');
    if (this.state.get(orderId) === 'CREATED') return { kind: 'done', value: undefined };
    if (this.createMode === 'reject') {
      return { kind: 'rejected', error: new ApiError(503, 'DISPATCH_UNAVAILABLE', 'Dispatch service is unavailable') };
    }
    if (this.createMode === 'timeout-before-create') {
      return { kind: 'in_doubt', error: new ApiError(504, 'DISPATCH_TIMEOUT', 'Dispatch service did not respond before the deadline') };
    }
    this.state.set(orderId, 'CREATED');
    this.items.set(orderId, items);
    return { kind: 'done', value: undefined };
  }

  async cancel(orderId: string, wasInDoubt: boolean): Promise<CompensationOutcome> {
    this.cancelCalls += 1;
    this.log.push('dispatch.cancel');
    if (this.cancelMode === 'unavailable') {
      return { kind: 'retry', error: new ApiError(503, 'DISPATCH_UNAVAILABLE', 'Dispatch service is unavailable') };
    }
    if (!this.state.has(orderId)) return wasInDoubt ? { kind: 'compensated' } : { kind: 'retry', error: new ApiError(500, 'INTERNAL_ERROR', 'x') };
    this.state.set(orderId, 'CANCELLED');
    return { kind: 'compensated' };
  }
}
