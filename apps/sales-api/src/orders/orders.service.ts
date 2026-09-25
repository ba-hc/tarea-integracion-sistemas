import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { ApiError } from '../common/api-error.js';
import { SALES_CONFIG, type SalesConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';
import { INVENTORY_GATEWAY, type InventoryGateway, type ReservedStockItem } from '../inventory/inventory.gateway.js';
import type { OrderCreateDto, OrderListQueryDto } from './order.dto.js';
import { toOrderView, type OrderView } from './order.mapper.js';

const ORDER_INCLUDE = { items: { orderBy: { partId: 'asc' } } } as const;

interface CreateOrderSuccess {
  kind: 'success';
  order: OrderView;
  replayed: boolean;
}
interface CreateOrderError {
  kind: 'error';
  error: ApiError;
}
type CreateOrderOutcome = CreateOrderSuccess | CreateOrderError;

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

function publicInventoryError(error: unknown): ApiError {
  return error instanceof ApiError
    ? error
    : new ApiError(500, 'INTERNAL_ERROR', 'An unexpected internal error occurred');
}

function storedFailure(status: number | null, body: Prisma.JsonValue | null): ApiError {
  const fallback = new ApiError(500, 'INTERNAL_ERROR', 'An unexpected internal error occurred');
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fallback;
  const code = body.code;
  const message = body.message;
  if (typeof code !== 'string' || typeof message !== 'string') return fallback;
  return new ApiError(status ?? 500, code, message);
}

function createResponseBody(order: OrderView): Prisma.InputJsonValue {
  return {
    id: order.id,
    customerId: order.customerId,
    status: 'CONFIRMED',
    items: order.items.map((item) => ({
      partId: item.partId,
      sku: item.sku,
      name: item.name,
      quantity: item.quantity,
    })),
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    cancelledAt: null,
  };
}

function restoreCreateResponse(body: Prisma.JsonValue | null, current: OrderView): OrderView {
  const snapshot = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Prisma.JsonObject
    : undefined;
  const createdAt = snapshot?.createdAt;
  const updatedAt = snapshot?.updatedAt;
  const parseDate = (value: Prisma.JsonValue | undefined, fallback: Date): Date => {
    if (typeof value !== 'string') return fallback;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? fallback : date;
  };
  return {
    ...current,
    status: 'CONFIRMED',
    createdAt: parseDate(createdAt, current.createdAt),
    updatedAt: parseDate(updatedAt, current.createdAt),
    cancelledAt: null,
  };
}

function internalCreateFailure(): ApiError {
  return new ApiError(500, 'INTERNAL_ERROR', 'An unexpected internal error occurred');
}

function assertReservationMatches(
  requested: Array<{ partId: string; quantity: number }>,
  reserved: ReservedStockItem[],
): void {
  if (requested.length !== reserved.length) throw new Error('Inventory reservation result did not match request');
  const byPart = new Map(reserved.map((item) => [item.partId.toLowerCase(), item]));
  for (const requestItem of requested) {
    const snapshot = byPart.get(requestItem.partId);
    if (!snapshot || snapshot.quantity !== requestItem.quantity) {
      throw new Error('Inventory reservation result did not match request');
    }
  }
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(INVENTORY_GATEWAY) private readonly inventory: InventoryGateway,
    @Inject(SALES_CONFIG) private readonly config: SalesConfig,
  ) {}

  private async recoverFailedCreate(
    idempotencyKey: string,
    traceId: string,
  ): Promise<CreateOrderOutcome> {
    const prepared = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "key" FROM "idempotency_requests" WHERE "key" = ${idempotencyKey} FOR UPDATE`;
      const entry = await tx.idempotencyRequest.findUnique({ where: { key: idempotencyKey } });
      if (!entry) throw new Error('Idempotency claim disappeared during compensation');
      if (entry.state === 'CONFIRMED') {
        const order = await tx.order.findUnique({ where: { id: entry.orderId }, include: ORDER_INCLUDE });
        if (!order) throw new Error('Confirmed idempotency record has no order');
        return {
          kind: 'success' as const,
          order: restoreCreateResponse(entry.responseBody, toOrderView(order)),
          replayed: true,
        };
      }
      if (entry.state === 'FAILED') {
        return { kind: 'error' as const, error: storedFailure(entry.responseStatus, entry.responseBody) };
      }
      if (entry.state === 'IN_PROGRESS') {
        const error = internalCreateFailure();
        await tx.idempotencyRequest.update({
          where: { key: idempotencyKey },
          data: {
            state: 'COMPENSATING',
            responseStatus: error.getStatus(),
            responseBody: { code: error.code, message: error.message },
          },
        });
      }
      return { kind: 'compensating' as const };
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 5_000,
      timeout: this.config.inventoryRpcDeadlineMs + 10_000,
    });
    if (prepared.kind !== 'compensating') return prepared;

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "key" FROM "idempotency_requests" WHERE "key" = ${idempotencyKey} FOR UPDATE`;
      const entry = await tx.idempotencyRequest.findUnique({ where: { key: idempotencyKey } });
      if (!entry) throw new Error('Idempotency claim disappeared during compensation');
      if (entry.state === 'CONFIRMED') {
        const order = await tx.order.findUnique({ where: { id: entry.orderId }, include: ORDER_INCLUDE });
        if (!order) throw new Error('Confirmed idempotency record has no order');
        return {
          kind: 'success' as const,
          order: restoreCreateResponse(entry.responseBody, toOrderView(order)),
          replayed: true,
        };
      }
      if (entry.state === 'FAILED') {
        return { kind: 'error' as const, error: storedFailure(entry.responseStatus, entry.responseBody) };
      }
      if (entry.state !== 'COMPENSATING') {
        throw new Error('Idempotency compensation state changed unexpectedly');
      }
      const error = storedFailure(entry.responseStatus, entry.responseBody);
      await this.inventory.release(entry.orderId, traceId);
      await tx.idempotencyRequest.update({
        where: { key: idempotencyKey },
        data: { state: 'FAILED' },
      });
      return { kind: 'error' as const, error };
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 5_000,
      timeout: this.config.inventoryRpcDeadlineMs + 10_000,
    });
  }

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

    let reservationOrderId: string | undefined;
    let reservationSucceeded = false;
    let outcome: CreateOrderOutcome;
    try {
      outcome = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "key" FROM "idempotency_requests" WHERE "key" = ${idempotencyKey} FOR UPDATE`;
        const entry = await tx.idempotencyRequest.findUnique({ where: { key: idempotencyKey } });
        if (!entry) throw new Error('Idempotency claim disappeared');
        if (entry.requestHash !== requestHash) {
          return { kind: 'error', error: new ApiError(409, 'IDEMPOTENCY_KEY_CONFLICT', 'This Idempotency-Key was already used with a different request payload') };
        }
        if (entry.state === 'CONFIRMED') {
          const order = await tx.order.findUnique({ where: { id: entry.orderId }, include: ORDER_INCLUDE });
          if (!order) throw new Error('Confirmed idempotency record has no order');
          return {
            kind: 'success',
            order: restoreCreateResponse(entry.responseBody, toOrderView(order)),
            replayed: true,
          };
        }
        if (entry.state === 'FAILED') {
          return {
            kind: 'error',
            error: storedFailure(entry.responseStatus, entry.responseBody),
          };
        }
        if (entry.state === 'COMPENSATING') {
          const error = storedFailure(entry.responseStatus, entry.responseBody);
          await this.inventory.release(entry.orderId, traceId);
          await tx.idempotencyRequest.update({
            where: { key: idempotencyKey },
            data: { state: 'FAILED' },
          });
          return { kind: 'error', error };
        }
        const customer = await tx.customer.findUnique({ where: { id: customerId }, select: { id: true } });
        if (!customer) {
          const error = new ApiError(404, 'CUSTOMER_NOT_FOUND', 'Customer not found');
          await tx.idempotencyRequest.update({
            where: { key: idempotencyKey },
            data: {
              state: 'FAILED',
              responseStatus: error.getStatus(),
              responseBody: { code: error.code, message: error.message },
            },
          });
          return { kind: 'error', error };
        }

        reservationOrderId = entry.orderId;
        let snapshots: ReservedStockItem[];
        try {
          snapshots = await this.inventory.reserve(entry.orderId, items, traceId);
        } catch (error) {
          const apiError = publicInventoryError(error);
          const ambiguousFailure = !(error instanceof ApiError) || apiError.getStatus() >= 500;
          if (ambiguousFailure) return { kind: 'error', error: apiError };
          await tx.idempotencyRequest.update({
            where: { key: idempotencyKey },
            data: {
              state: 'FAILED',
              responseStatus: apiError.getStatus(),
              responseBody: { code: apiError.code, message: apiError.message },
            },
          });
          return { kind: 'error', error: apiError };
        }

        reservationSucceeded = true;
        assertReservationMatches(items, snapshots);
        const order = await tx.order.create({
          data: {
            id: entry.orderId,
            customerId,
            status: 'CONFIRMED',
            items: {
              create: snapshots.map((item) => ({
                partId: item.partId.toLowerCase(),
                partSkuSnapshot: item.sku,
                partNameSnapshot: item.name,
                quantity: item.quantity,
              })),
            },
          },
          include: ORDER_INCLUDE,
        });
        const orderView = toOrderView(order);
        await tx.idempotencyRequest.update({
          where: { key: idempotencyKey },
          data: { state: 'CONFIRMED', responseStatus: 201, responseBody: createResponseBody(orderView) },
        });
        return { kind: 'success', order: orderView, replayed: false };
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 5_000,
        timeout: this.config.inventoryRpcDeadlineMs + 10_000,
      });
    } catch (error) {
      let recoveryOutcome: CreateOrderOutcome | undefined;
      if (reservationSucceeded && reservationOrderId) {
        try {
          recoveryOutcome = await this.recoverFailedCreate(idempotencyKey, traceId);
        } catch (compensationError) {
          const errorCode = compensationError instanceof ApiError
            ? compensationError.code
            : compensationError instanceof Prisma.PrismaClientKnownRequestError
              ? compensationError.code
              : undefined;
          this.logger.error('inventory reservation compensation failed', {
            traceId,
            orderId: reservationOrderId,
            errorType: compensationError instanceof Error ? compensationError.name : 'UnknownError',
            ...(errorCode === undefined ? {} : { errorCode }),
          });
        }
      }
      const errorCode = error instanceof ApiError
        ? error.code
        : error instanceof Prisma.PrismaClientKnownRequestError
          ? error.code
          : undefined;
      this.logger.error('order creation failed', {
        traceId,
        orderId: reservationOrderId,
        errorType: error instanceof Error ? error.name : 'UnknownError',
        ...(errorCode === undefined ? {} : { errorCode }),
        recoveredState: recoveryOutcome?.kind,
      });
      if (recoveryOutcome?.kind === 'success') return recoveryOutcome;
      if (recoveryOutcome?.kind === 'error') throw recoveryOutcome.error;
      throw internalCreateFailure();
    }

    if (outcome.kind === 'error') throw outcome.error;
    return outcome;
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

  async cancel(orderId: string, traceId: string): Promise<OrderView> {
    const id = orderId.toLowerCase();
    const current = await this.prisma.order.findUnique({ where: { id }, include: ORDER_INCLUDE });
    if (!current) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found');
    if (current.status === 'CANCELLED') return toOrderView(current);

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
