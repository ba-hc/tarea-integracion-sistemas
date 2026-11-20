import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, type SaleSaga, type SaleSagaStepStatus } from '../generated/prisma/client.js';
import { ApiError } from '../common/api-error.js';
import { SAGA_STEP_ORDER, SALES_CONFIG, type SagaStepName, type SalesConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';
import { INVENTORY_GATEWAY, type InventoryGateway, type ReservedStockItem } from '../inventory/inventory.gateway.js';
import { toOrderView, type OrderView } from '../orders/order.mapper.js';
import { createResponseBody, ORDER_INCLUDE, restoreCreateResponse } from '../orders/order-response.js';
import { DISPATCH_GATEWAY, type DispatchGateway } from './dispatch.client.js';
import { PAYMENTS_GATEWAY, type PaymentsGateway } from './payments.client.js';
import { INTERNAL_ERROR, type CompensationOutcome, type StepOutcome } from './saga-outcome.js';

/**
 * Orquestador de la Saga «vender un repuesto» (T2-301 / T2-302).
 *
 *   Paso 1  reservar stock  (Inventory gRPC)   compensación: liberar stock
 *   Paso 2  cobrar          (Pagos REST)       compensación: reembolsar
 *   Paso 3  crear despacho  (Despacho REST)    compensación: cancelar despacho
 *
 * Reglas que hacen defendible el diseño:
 *
 * 1. Write-ahead: antes de enviar un comando, el paso se marca `IN_DOUBT` en la
 *    base de Sales. Si el proceso muere a mitad de la llamada, el estado
 *    persistido ya dice «no sabemos si se aplicó», nunca «no se hizo».
 * 2. Todos los comandos y compensaciones usan el mismo `orderId` y son
 *    idempotentes en cada servicio: repetirlos no cobra, reserva ni despacha dos
 *    veces. Por eso reintentar es siempre seguro.
 * 3. Un rechazo confirmado (`rejected`) dispara las compensaciones de los pasos
 *    ya confirmados, en orden inverso y estricto: no se reembolsa antes de
 *    cancelar el despacho ni se libera stock antes de reembolsar.
 * 4. Un resultado en duda no compensa en caliente: la llamada original podría
 *    seguir en curso. Se responde 503/504, el cliente puede reintentar con la
 *    misma Idempotency-Key (avanza con el mismo comando) y, si no lo hace, el
 *    recuperador aborta y compensa pasado `SAGA_ABORT_AFTER_MS`.
 * 5. Un lease con dueño (`lease_owner`) asegura que un solo proceso avanza cada
 *    Saga; toda escritura comprueba que el lease sigue siendo propio.
 * 6. La orden pública sólo se crea al final, en la misma transacción local que
 *    marca la Saga `COMPLETED`: nunca se expone una orden a medio vender.
 */

export type SaleRunResult =
  | { kind: 'success'; order: OrderView; replayed: boolean }
  | { kind: 'error'; error: ApiError };

type StepField = 'stockStatus' | 'paymentStatus' | 'dispatchStatus';
const STEP_FIELD: Readonly<Record<SagaStepName, StepField>> = {
  stock: 'stockStatus',
  payment: 'paymentStatus',
  dispatch: 'dispatchStatus',
};

type CompensationRun = { kind: 'compensated' } | { kind: 'pending'; error: ApiError };

/** Otro proceso tomó la Saga (lease vencido): se abandona sin escribir nada más. */
class LeaseLostError extends Error {
  constructor(orderId: string) {
    super(`saga lease lost for order ${orderId}`);
    this.name = 'LeaseLostError';
  }
}

const LEASE_POLL_MS = 25;

function sagaItems(saga: SaleSaga): Array<{ partId: string; quantity: number }> {
  return saga.items as Array<{ partId: string; quantity: number }>;
}

function failureOf(saga: Pick<SaleSaga, 'failureStatus' | 'failureCode' | 'failureMessage'>): ApiError {
  if (saga.failureStatus === null || saga.failureCode === null || saga.failureMessage === null) return INTERNAL_ERROR();
  return new ApiError(saga.failureStatus, saga.failureCode, saga.failureMessage);
}

function lastErrorOf(saga: SaleSaga): ApiError {
  if (saga.lastErrorStatus === null || saga.lastErrorCode === null || saga.lastErrorMessage === null) return INTERNAL_ERROR();
  return new ApiError(saga.lastErrorStatus, saga.lastErrorCode, saga.lastErrorMessage);
}

function errorFields(prefix: 'failure' | 'lastError', error: ApiError | null) {
  return {
    [`${prefix}Status`]: error?.getStatus() ?? null,
    [`${prefix}Code`]: error?.code ?? null,
    [`${prefix}Message`]: error?.message ?? null,
  } as Partial<Prisma.SaleSagaUpdateManyMutationInput>;
}

function assertReservationMatches(
  requested: Array<{ partId: string; quantity: number }>,
  reserved: ReservedStockItem[],
): boolean {
  if (requested.length !== reserved.length) return false;
  const byPart = new Map(reserved.map((item) => [item.partId.toLowerCase(), item]));
  return requested.every((item) => byPart.get(item.partId)?.quantity === item.quantity);
}

@Injectable()
export class SaleSagaOrchestrator {
  private readonly logger = new Logger('SaleSaga');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(INVENTORY_GATEWAY) private readonly inventory: InventoryGateway,
    @Inject(PAYMENTS_GATEWAY) private readonly payments: PaymentsGateway,
    @Inject(DISPATCH_GATEWAY) private readonly dispatch: DispatchGateway,
    @Inject(SALES_CONFIG) private readonly config: Pick<SalesConfig, 'saga'>,
  ) {}

  /**
   * Estado inicial de los pasos según `SAGA_STEPS`. Se persiste al crear la
   * Saga para que cambiar la configuración no altere ventas ya iniciadas.
   */
  initialStepStatuses(): Record<StepField, SaleSagaStepStatus> {
    const status = (step: SagaStepName): SaleSagaStepStatus =>
      this.config.saga.steps.includes(step) ? 'NOT_STARTED' : 'SKIPPED';
    return { stockStatus: status('stock'), paymentStatus: status('payment'), dispatchStatus: status('dispatch') };
  }

  /** Monto de la venta: unidades × precio unitario configurado (decisión del equipo, P3-SAGA.md). */
  amountFor(items: Array<{ quantity: number }>): bigint {
    const units = items.reduce((total, item) => total + item.quantity, 0);
    return BigInt(units) * BigInt(this.config.saga.unitPriceMinor);
  }

  get currency(): string {
    return this.config.saga.currency;
  }

  /** Avanza la Saga de una venta hasta un estado estable y devuelve la respuesta de creación. */
  async runSale(orderId: string, traceId: string): Promise<SaleRunResult> {
    const owner = randomUUID();
    if (!(await this.acquireLeaseWaiting(orderId, owner))) {
      this.logger.error('saga lease not acquired in time', { orderId, traceId });
      return { kind: 'error', error: INTERNAL_ERROR() };
    }
    try {
      const saga = await this.prisma.saleSaga.findUniqueOrThrow({ where: { orderId } });
      switch (saga.status) {
        case 'COMPLETED':
        case 'CANCELLING':
        case 'CANCELLED':
          return await this.replay(saga);
        case 'FAILED':
          return { kind: 'error', error: failureOf(saga) };
        case 'COMPENSATING':
          await this.compensate(saga, owner, traceId);
          return { kind: 'error', error: failureOf(saga) };
        case 'RUNNING':
          return await this.forward(saga, owner, traceId);
      }
    } catch (error) {
      this.logUnexpected('saga run failed', error, orderId, traceId);
      return { kind: 'error', error: INTERNAL_ERROR() };
    } finally {
      await this.releaseLease(orderId, owner, traceId);
    }
  }

  /**
   * Cancelación pública de una orden confirmada: compensa los tres pasos en
   * orden inverso y sólo entonces marca la orden `CANCELLED`. Si una
   * compensación no se confirma, la orden sigue `CONFIRMED`, el error se
   * devuelve al cliente y la cancelación queda pendiente para el recuperador.
   */
  async cancelSale(orderId: string, traceId: string): Promise<OrderView> {
    const owner = randomUUID();
    if (!(await this.acquireLeaseWaiting(orderId, owner))) {
      this.logger.error('saga lease not acquired in time', { orderId, traceId });
      throw INTERNAL_ERROR();
    }
    try {
      const saga = await this.prisma.saleSaga.findUniqueOrThrow({ where: { orderId } });
      if (saga.status === 'COMPLETED') {
        await this.update(saga, owner, { status: 'CANCELLING', compensationAttempts: 0, nextAttemptAt: null });
        await this.event(saga, 'sale', 'CANCEL', 'REQUESTED', undefined, traceId);
      } else if (saga.status !== 'CANCELLING' && saga.status !== 'CANCELLED') {
        this.logger.error('confirmed order has a saga that is not completed', { orderId, status: saga.status, traceId });
        throw INTERNAL_ERROR();
      }
      if (saga.status === 'CANCELLING') {
        const result = await this.compensate(saga, owner, traceId);
        if (result.kind === 'pending') throw result.error;
      }
      const order = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: ORDER_INCLUDE });
      return toOrderView(order);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      this.logUnexpected('saga cancellation failed', error, orderId, traceId);
      throw INTERNAL_ERROR();
    } finally {
      await this.releaseLease(orderId, owner, traceId);
    }
  }

  /**
   * Trabajo del recuperador sobre una Saga: termina compensaciones o
   * cancelaciones pendientes y aborta Sagas detenidas con un paso en duda.
   * Si otro proceso tiene el lease, no hace nada: lo intentará en la próxima vuelta.
   */
  async recover(orderId: string): Promise<void> {
    const owner = randomUUID();
    const traceId = randomUUID();
    if (!(await this.tryAcquireLease(orderId, owner))) return;
    try {
      const saga = await this.prisma.saleSaga.findUniqueOrThrow({ where: { orderId } });
      if (saga.status === 'RUNNING') {
        const staleBefore = Date.now() - this.config.saga.abortAfterMs;
        if (saga.updatedAt.getTime() > staleBefore) return;
        const pendingSteps = SAGA_STEP_ORDER.filter((step) => !['DONE', 'SKIPPED'].includes(saga[STEP_FIELD[step]]));
        if (pendingSteps.length === 0) {
          // Todos los pasos remotos se confirmaron y sólo faltó la persistencia local.
          await this.finalize(saga, owner, traceId);
          return;
        }
        await this.abort(saga, owner, traceId);
      }
      if (saga.status === 'COMPENSATING' || saga.status === 'CANCELLING') {
        await this.compensate(saga, owner, traceId);
      }
    } catch (error) {
      this.logUnexpected('saga recovery failed', error, orderId, traceId);
    } finally {
      await this.releaseLease(orderId, owner, traceId);
    }
  }

  /** Sagas que el recuperador debe revisar ahora. */
  async findRecoverable(limit: number): Promise<string[]> {
    const now = new Date();
    const rows = await this.prisma.saleSaga.findMany({
      where: {
        OR: [
          {
            status: { in: ['COMPENSATING', 'CANCELLING'] },
            OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
          },
          { status: 'RUNNING', updatedAt: { lt: new Date(now.getTime() - this.config.saga.abortAfterMs) } },
        ],
      },
      select: { orderId: true },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    });
    return rows.map((row) => row.orderId);
  }

  // --- Avance -----------------------------------------------------------------

  private async forward(saga: SaleSaga, owner: string, traceId: string): Promise<SaleRunResult> {
    for (const step of SAGA_STEP_ORDER) {
      const field = STEP_FIELD[step];
      if (saga[field] === 'DONE' || saga[field] === 'SKIPPED') continue;

      // Write-ahead: desde aquí el paso queda «en duda» hasta saber el resultado.
      await this.update(saga, owner, { [field]: 'IN_DOUBT' });
      const startedAt = performance.now();
      const outcome = await this.executeStep(step, saga, traceId);
      this.logger.log('saga step executed', {
        orderId: saga.orderId,
        step,
        outcome: outcome.kind,
        code: outcome.kind === 'done' ? undefined : outcome.error.code,
        durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
        traceId,
      });
      await this.event(saga, step, 'EXECUTE', outcome.kind.toUpperCase(), outcome.kind === 'done' ? undefined : outcome.error.code, traceId);

      if (outcome.kind === 'done') {
        await this.update(saga, owner, {
          [field]: 'DONE',
          ...(step === 'stock' ? { reservation: outcome.value as unknown as Prisma.InputJsonValue } : {}),
          ...errorFields('lastError', null),
        });
        continue;
      }
      if (outcome.kind === 'in_doubt') {
        // No se compensa en caliente: la llamada original podría seguir en curso.
        await this.update(saga, owner, errorFields('lastError', outcome.error));
        return { kind: 'error', error: outcome.error };
      }

      // Rechazo confirmado: la venta fracasa y se compensan los pasos ya confirmados.
      await this.startCompensation(saga, owner, outcome.error, { [field]: 'REJECTED' });
      await this.compensate(saga, owner, traceId);
      return { kind: 'error', error: outcome.error };
    }
    return this.finalize(saga, owner, traceId);
  }

  private async executeStep(step: SagaStepName, saga: SaleSaga, traceId: string): Promise<StepOutcome<ReservedStockItem[] | undefined>> {
    try {
      switch (step) {
        case 'stock':
          return await this.reserveStock(saga, traceId);
        case 'payment':
          return await this.payments.charge(saga.orderId, Number(saga.amountMinor), saga.currency, traceId);
        case 'dispatch':
          return await this.dispatch.create(saga.orderId, sagaItems(saga), traceId);
      }
    } catch (error) {
      this.logUnexpected('saga step threw', error, saga.orderId, traceId);
      return { kind: 'in_doubt', error: INTERNAL_ERROR() };
    }
  }

  private async reserveStock(saga: SaleSaga, traceId: string): Promise<StepOutcome<ReservedStockItem[]>> {
    const items = sagaItems(saga);
    let snapshots: ReservedStockItem[];
    try {
      snapshots = await this.inventory.reserve(saga.orderId, items, traceId);
    } catch (error) {
      if (!(error instanceof ApiError)) return { kind: 'in_doubt', error: INTERNAL_ERROR() };
      // 4xx: Inventory confirmó que no reservó (stock, pieza o validación). 5xx: en duda.
      return error.getStatus() < 500 ? { kind: 'rejected', error } : { kind: 'in_doubt', error };
    }
    if (!assertReservationMatches(items, snapshots)) {
      this.logger.error('inventory reservation result did not match request', { orderId: saga.orderId, traceId });
      return { kind: 'in_doubt', error: INTERNAL_ERROR() };
    }
    return { kind: 'done', value: snapshots };
  }

  /**
   * Única transacción que hace pública la venta: crea la orden CONFIRMED con
   * los snapshots de la reserva, guarda la respuesta para replays y cierra la
   * Saga. Si el commit falla, la Saga sigue RUNNING con todos los pasos DONE y
   * el siguiente intento (mismo Idempotency-Key o recuperador) sólo repite esto.
   */
  private async finalize(saga: SaleSaga, owner: string, traceId: string): Promise<SaleRunResult> {
    const reservation = saga.reservation as unknown as ReservedStockItem[] | null;
    if (!reservation) throw new Error('completed saga has no reservation snapshot');
    try {
      const order = await this.prisma.$transaction(async (tx) => {
        const created = await tx.order.create({
          data: {
            id: saga.orderId,
            customerId: saga.customerId,
            status: 'CONFIRMED',
            items: {
              create: reservation.map((item) => ({
                partId: item.partId.toLowerCase(),
                partSkuSnapshot: item.sku,
                partNameSnapshot: item.name,
                quantity: item.quantity,
              })),
            },
          },
          include: ORDER_INCLUDE,
        });
        const view = toOrderView(created);
        await tx.idempotencyRequest.update({
          where: { key: saga.idempotencyKey },
          data: { state: 'CONFIRMED', responseStatus: 201, responseBody: createResponseBody(view) },
        });
        const closed = await tx.saleSaga.updateMany({
          where: { orderId: saga.orderId, leaseOwner: owner },
          data: { status: 'COMPLETED', ...errorFields('lastError', null) },
        });
        if (closed.count !== 1) throw new LeaseLostError(saga.orderId);
        return view;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 10_000 });
      saga.status = 'COMPLETED';
      await this.event(saga, 'sale', 'COMPLETE', 'DONE', undefined, traceId);
      this.logger.log('sale completed', { orderId: saga.orderId, traceId });
      return { kind: 'success', order, replayed: false };
    } catch (error) {
      // ¿Se perdió sólo el ACK del commit? Entonces la venta sí quedó confirmada.
      const current = await this.prisma.saleSaga.findUnique({ where: { orderId: saga.orderId } });
      if (current?.status === 'COMPLETED') return this.replay(current);
      this.logUnexpected('sale finalization failed; it will be retried', error, saga.orderId, traceId);
      return { kind: 'error', error: INTERNAL_ERROR() };
    }
  }

  private async replay(saga: SaleSaga): Promise<SaleRunResult> {
    const [entry, order] = await Promise.all([
      this.prisma.idempotencyRequest.findUniqueOrThrow({ where: { key: saga.idempotencyKey } }),
      this.prisma.order.findUniqueOrThrow({ where: { id: saga.orderId }, include: ORDER_INCLUDE }),
    ]);
    return { kind: 'success', order: restoreCreateResponse(entry.responseBody, toOrderView(order)), replayed: true };
  }

  // --- Compensación -----------------------------------------------------------

  /**
   * Fija el resultado público de la venta fallida (se repetirá en cada
   * reintento con la misma key) y pasa la Saga a COMPENSATING, todo en una
   * transacción local.
   */
  private async startCompensation(
    saga: SaleSaga,
    owner: string,
    failure: ApiError,
    extra: Partial<Prisma.SaleSagaUpdateManyMutationInput> = {},
  ): Promise<void> {
    const data = { ...extra, status: 'COMPENSATING' as const, ...errorFields('failure', failure), nextAttemptAt: null };
    await this.prisma.$transaction(async (tx) => {
      const moved = await tx.saleSaga.updateMany({ where: { orderId: saga.orderId, leaseOwner: owner }, data });
      if (moved.count !== 1) throw new LeaseLostError(saga.orderId);
      await tx.idempotencyRequest.update({
        where: { key: saga.idempotencyKey },
        data: {
          state: 'COMPENSATING',
          responseStatus: failure.getStatus(),
          responseBody: { code: failure.code, message: failure.message },
        },
      });
    });
    Object.assign(saga, data);
  }

  /** Aborta una Saga detenida con un paso en duda; el cliente ya recibió `lastError`. */
  private async abort(saga: SaleSaga, owner: string, traceId: string): Promise<void> {
    const failure = lastErrorOf(saga);
    this.logger.warn('aborting stalled saga', { orderId: saga.orderId, code: failure.code, traceId });
    await this.startCompensation(saga, owner, failure);
    await this.event(saga, 'sale', 'ABORT', 'STALLED', failure.code, traceId);
  }

  /**
   * Compensa en orden inverso los pasos confirmados (`DONE`) o en duda
   * (`IN_DOUBT`). Se detiene en la primera compensación que no se confirma: el
   * orden inverso es estricto y la Saga queda pendiente con backoff.
   */
  private async compensate(saga: SaleSaga, owner: string, traceId: string): Promise<CompensationRun> {
    for (const step of [...SAGA_STEP_ORDER].reverse()) {
      const field = STEP_FIELD[step];
      const status = saga[field];
      if (status !== 'DONE' && status !== 'IN_DOUBT') continue;

      const wasInDoubt = status === 'IN_DOUBT';
      const startedAt = performance.now();
      const outcome = await this.compensateStep(step, saga, wasInDoubt, traceId);
      this.logger.log('saga step compensated', {
        orderId: saga.orderId,
        step,
        outcome: outcome.kind,
        wasInDoubt,
        code: outcome.kind === 'retry' ? outcome.error.code : undefined,
        durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
        traceId,
      });
      await this.event(saga, step, 'COMPENSATE', outcome.kind === 'compensated' ? 'COMPENSATED' : 'RETRY', outcome.kind === 'retry' ? outcome.error.code : undefined, traceId);

      if (outcome.kind === 'compensated') {
        await this.update(saga, owner, { [field]: 'COMPENSATED' });
        continue;
      }
      const attempts = saga.compensationAttempts + 1;
      const backoffMs = Math.min(this.config.saga.recoveryIntervalMs * 2 ** (attempts - 1), this.config.saga.maxBackoffMs);
      await this.update(saga, owner, {
        compensationAttempts: attempts,
        nextAttemptAt: new Date(Date.now() + backoffMs),
        ...errorFields('lastError', outcome.error),
      });
      this.logger.warn('saga compensation pending', { orderId: saga.orderId, step, attempts, backoffMs, traceId });
      return { kind: 'pending', error: outcome.error };
    }

    if (saga.status === 'CANCELLING') {
      await this.prisma.$transaction(async (tx) => {
        await tx.order.update({ where: { id: saga.orderId }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
        const closed = await tx.saleSaga.updateMany({
          where: { orderId: saga.orderId, leaseOwner: owner },
          data: { status: 'CANCELLED', nextAttemptAt: null, ...errorFields('lastError', null) },
        });
        if (closed.count !== 1) throw new LeaseLostError(saga.orderId);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 10_000 });
      saga.status = 'CANCELLED';
      await this.event(saga, 'sale', 'CANCEL', 'DONE', undefined, traceId);
    } else {
      await this.prisma.$transaction(async (tx) => {
        const closed = await tx.saleSaga.updateMany({
          where: { orderId: saga.orderId, leaseOwner: owner },
          data: { status: 'FAILED', nextAttemptAt: null, ...errorFields('lastError', null) },
        });
        if (closed.count !== 1) throw new LeaseLostError(saga.orderId);
        await tx.idempotencyRequest.update({ where: { key: saga.idempotencyKey }, data: { state: 'FAILED' } });
      });
      saga.status = 'FAILED';
      await this.event(saga, 'sale', 'FAIL', 'COMPENSATED', saga.failureCode ?? undefined, traceId);
    }
    this.logger.log('saga compensation finished', { orderId: saga.orderId, status: saga.status, traceId });
    return { kind: 'compensated' };
  }

  private async compensateStep(step: SagaStepName, saga: SaleSaga, wasInDoubt: boolean, traceId: string): Promise<CompensationOutcome> {
    try {
      switch (step) {
        case 'dispatch':
          return await this.dispatch.cancel(saga.orderId, wasInDoubt, traceId);
        case 'payment':
          return await this.payments.refund(saga.orderId, wasInDoubt, traceId);
        case 'stock': {
          const result = await this.inventory.releaseForCompensation(saga.orderId, traceId);
          if (result === 'RELEASED' || wasInDoubt) return { kind: 'compensated' };
          this.logger.error('reservation confirmed by the saga is unknown to Inventory', { orderId: saga.orderId, traceId });
          return { kind: 'retry', error: INTERNAL_ERROR() };
        }
      }
    } catch (error) {
      if (error instanceof ApiError) return { kind: 'retry', error };
      this.logUnexpected('saga compensation threw', error, saga.orderId, traceId);
      return { kind: 'retry', error: INTERNAL_ERROR() };
    }
  }

  // --- Persistencia, lease y bitácora -----------------------------------------

  /** Escribe sólo si el lease sigue siendo propio; refleja el cambio en `saga`. */
  private async update(saga: SaleSaga, owner: string, data: Partial<Prisma.SaleSagaUpdateManyMutationInput>): Promise<void> {
    const result = await this.prisma.saleSaga.updateMany({ where: { orderId: saga.orderId, leaseOwner: owner }, data });
    if (result.count !== 1) throw new LeaseLostError(saga.orderId);
    Object.assign(saga, data);
  }

  private async event(
    saga: SaleSaga,
    step: SagaStepName | 'sale',
    action: string,
    outcome: string,
    code: string | undefined,
    traceId: string,
  ): Promise<void> {
    await this.prisma.saleSagaEvent.create({
      data: { orderId: saga.orderId, step, action, outcome, code: code ?? null, traceId: traceId.slice(0, 128) },
    });
  }

  private async tryAcquireLease(orderId: string, owner: string): Promise<boolean> {
    const updated = await this.prisma.$executeRaw`
      UPDATE "sale_sagas"
      SET "lease_owner" = ${owner}::uuid,
          "lease_until" = now() + (${this.config.saga.leaseMs}::int * interval '1 millisecond')
      WHERE "order_id" = ${orderId}::uuid
        AND ("lease_until" IS NULL OR "lease_until" < now())
    `;
    return updated === 1;
  }

  /** Un reintento concurrente con la misma key espera a que termine el intento en curso. */
  private async acquireLeaseWaiting(orderId: string, owner: string): Promise<boolean> {
    const deadline = Date.now() + this.config.saga.leaseMs + 1_000;
    while (Date.now() < deadline) {
      if (await this.tryAcquireLease(orderId, owner)) return true;
      await delay(LEASE_POLL_MS);
    }
    return false;
  }

  private async releaseLease(orderId: string, owner: string, traceId: string): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        UPDATE "sale_sagas" SET "lease_owner" = NULL, "lease_until" = NULL
        WHERE "order_id" = ${orderId}::uuid AND "lease_owner" = ${owner}::uuid
      `;
    } catch (error) {
      // El lease vence solo; no liberarlo sólo retrasa el siguiente intento.
      this.logUnexpected('saga lease release failed', error, orderId, traceId);
    }
  }

  private logUnexpected(message: string, error: unknown, orderId: string, traceId: string): void {
    this.logger.error(message, {
      orderId,
      traceId,
      errorType: error instanceof Error ? error.name : 'UnknownError',
      ...(error instanceof Prisma.PrismaClientKnownRequestError ? { errorCode: error.code } : {}),
    });
  }
}
