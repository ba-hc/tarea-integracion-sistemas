import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { ApiError } from '../common/api-error.js';
import { PrismaService } from '../database/prisma.service.js';
import { INVENTORY_GATEWAY, type InventoryGateway } from '../inventory/inventory.gateway.js';
import { SaleSagaOrchestrator } from '../saga/sale-saga.orchestrator.js';
import type { OrderCreateDto, OrderListQueryDto } from './order.dto.js';
import { toOrderView, type OrderView } from './order.mapper.js';
import { ORDER_INCLUDE, restoreCreateResponse, storedFailure } from './order-response.js';

interface CreateOrderSuccess {
  kind: 'success';
  order: OrderView;
  replayed: boolean;
}

/** Resultado del paso local que reclama la Idempotency-Key antes de tocar otros servicios. */
type ClaimOutcome =
  | CreateOrderSuccess
  | { kind: 'error'; error: ApiError }
  | { kind: 'run'; orderId: string };

function normalizeItems(items: OrderCreateDto['items']): Array<{ partId: string; quantity: number }> {
  return items
    .map(({ partId, quantity }) => ({ partId: partId.toLowerCase(), quantity }))
    .sort((left, right) => (left.partId < right.partId ? -1 : left.partId > right.partId ? 1 : 0));
}

function hashRequest(customerId: string, items: Array<{ partId: string; quantity: number }>): string {
  const canonical = JSON.stringify({ customerId: customerId.toLowerCase(), items });
  return createHash('sha256').update(canonical).digest('hex');
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(INVENTORY_GATEWAY) private readonly inventory: InventoryGateway,
    @Inject(SaleSagaOrchestrator) private readonly saga: SaleSagaOrchestrator,
  ) {}

  /**
   * `POST /v1/orders`: la operación «vender un repuesto».
   *
   * 1. Reclama la Idempotency-Key en una transacción local corta, sin llamadas
   *    remotas mientras se tiene el lock: conflicto, replay o error guardado se
   *    resuelven aquí. Una key nueva crea la Saga con un `orderId` estable.
   * 2. La Saga reserva, cobra y despacha (o compensa) fuera de esa transacción.
   */
  async create(
    body: OrderCreateDto,
    idempotencyKey: string | undefined,
    traceId: string,
  ): Promise<CreateOrderSuccess> {
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed', {
        fieldErrors: [{ field: 'Idempotency-Key', reason: 'must match the required 8–128 character format' }],
      });
    }

    const customerId = body.customerId.toLowerCase();
    const items = normalizeItems(body.items);
    const requestHash = hashRequest(customerId, items);
    try {
      await this.prisma.idempotencyRequest.create({
        data: { key: idempotencyKey, requestHash, orderId: randomUUID(), state: 'IN_PROGRESS' },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }

    const claim = await this.claim(idempotencyKey, requestHash, customerId, items);
    if (claim.kind === 'success') return claim;
    if (claim.kind === 'error') throw claim.error;

    const result = await this.saga.runSale(claim.orderId, traceId);
    if (result.kind === 'error') throw result.error;
    return result;
  }

  private claim(
    idempotencyKey: string,
    requestHash: string,
    customerId: string,
    items: Array<{ partId: string; quantity: number }>,
  ): Promise<ClaimOutcome> {
    return this.prisma.$transaction(async (tx): Promise<ClaimOutcome> => {
      await tx.$queryRaw`SELECT "key" FROM "idempotency_requests" WHERE "key" = ${idempotencyKey} FOR UPDATE`;
      const entry = await tx.idempotencyRequest.findUnique({ where: { key: idempotencyKey } });
      if (!entry) throw new Error('Idempotency claim disappeared');
      if (entry.requestHash !== requestHash) {
        return { kind: 'error', error: new ApiError(409, 'IDEMPOTENCY_KEY_CONFLICT', 'This Idempotency-Key was already used with a different request payload') };
      }
      if (entry.state === 'CONFIRMED') {
        const order = await tx.order.findUnique({ where: { id: entry.orderId }, include: ORDER_INCLUDE });
        if (!order) throw new Error('Confirmed idempotency record has no order');
        return { kind: 'success', order: restoreCreateResponse(entry.responseBody, toOrderView(order)), replayed: true };
      }
      if (entry.state === 'FAILED') {
        return { kind: 'error', error: storedFailure(entry.responseStatus, entry.responseBody) };
      }

      // IN_PROGRESS o COMPENSATING: la venta sigue viva y la avanza la Saga.
      const existing = await tx.saleSaga.findUnique({ where: { orderId: entry.orderId }, select: { orderId: true } });
      if (existing) return { kind: 'run', orderId: entry.orderId };

      const amountMinor = this.saga.amountFor(items);
      if (entry.state === 'COMPENSATING') {
        // Claim heredado de la T1 (anterior a la Saga): sólo pudo haber reservado stock.
        const failure = storedFailure(entry.responseStatus, entry.responseBody);
        await tx.saleSaga.create({
          data: {
            orderId: entry.orderId,
            idempotencyKey,
            customerId,
            items,
            amountMinor,
            currency: this.saga.currency,
            status: 'COMPENSATING',
            stockStatus: 'IN_DOUBT',
            paymentStatus: 'SKIPPED',
            dispatchStatus: 'SKIPPED',
            failureStatus: failure.getStatus(),
            failureCode: failure.code,
            failureMessage: failure.message,
          },
        });
        return { kind: 'run', orderId: entry.orderId };
      }

      const customer = await tx.customer.findUnique({ where: { id: customerId }, select: { id: true } });
      if (!customer) {
        const error = new ApiError(404, 'CUSTOMER_NOT_FOUND', 'Customer not found');
        await tx.idempotencyRequest.update({
          where: { key: idempotencyKey },
          data: { state: 'FAILED', responseStatus: error.getStatus(), responseBody: { code: error.code, message: error.message } },
        });
        return { kind: 'error', error };
      }

      await tx.saleSaga.create({
        data: {
          orderId: entry.orderId,
          idempotencyKey,
          customerId,
          items,
          amountMinor,
          currency: this.saga.currency,
          status: 'RUNNING',
          ...this.saga.initialStepStatuses(),
        },
      });
      return { kind: 'run', orderId: entry.orderId };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 10_000 });
  }

  async list(query: OrderListQueryDto): Promise<{ page: number; pageSize: number; total: number; items: OrderView[] }> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where: Prisma.OrderWhereInput = {
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.customerId === undefined ? {} : { customerId: query.customerId.toLowerCase() }),
    };
    const [total, orders] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        include: ORDER_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { page, pageSize, total, items: orders.map(toOrderView) };
  }

  async get(orderId: string): Promise<OrderView> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId.toLowerCase() }, include: ORDER_INCLUDE });
    if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found');
    return toOrderView(order);
  }

  /**
   * `POST /v1/orders/{orderId}/cancel`. Una orden vendida por la Saga se
   * cancela compensando despacho → pago → stock y sólo entonces pasa a
   * CANCELLED. Las órdenes creadas antes de la T2 no tienen Saga y conservan
   * la cancelación de la T1 (liberar stock).
   */
  async cancel(orderId: string, traceId: string): Promise<OrderView> {
    const id = orderId.toLowerCase();
    const current = await this.prisma.order.findUnique({ where: { id }, include: ORDER_INCLUDE });
    if (!current) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found');
    if (current.status === 'CANCELLED') return toOrderView(current);

    const hasSaga = await this.prisma.saleSaga.count({ where: { orderId: id } });
    if (hasSaga > 0) return this.saga.cancelSale(id, traceId);
    return this.cancelWithoutSaga(id, traceId);
  }

  private async cancelWithoutSaga(id: string, traceId: string): Promise<OrderView> {
    await this.inventory.release(id, traceId);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${id}::uuid FOR UPDATE`;
        const locked = await tx.order.findUnique({ where: { id }, include: ORDER_INCLUDE });
        if (!locked) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found');
        if (locked.status === 'CANCELLED') return toOrderView(locked);
        const cancelled = await tx.order.update({
          where: { id },
          data: { status: 'CANCELLED', cancelledAt: new Date() },
          include: ORDER_INCLUDE,
        });
        return toOrderView(cancelled);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 10_000 });
    } catch (error) {
      this.logger.error('order cancellation persistence failed after inventory release', {
        traceId,
        orderId: id,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      throw new ApiError(500, 'INTERNAL_ERROR', 'An unexpected internal error occurred');
    }
  }
}
