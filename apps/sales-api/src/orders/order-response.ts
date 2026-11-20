import type { Prisma } from '../generated/prisma/client.js';
import { ApiError } from '../common/api-error.js';
import type { OrderView } from './order.mapper.js';

/** Incluye los ítems de la orden en el orden estable que usa la respuesta pública. */
export const ORDER_INCLUDE = { items: { orderBy: { partId: 'asc' } } } as const;

/** Respuesta 201 original que se guarda para reproducirla ante un reintento con la misma key. */
export function createResponseBody(order: OrderView): Prisma.InputJsonValue {
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

/**
 * Reproduce la respuesta de creación original aunque la orden se haya
 * cancelado después: un replay devuelve lo mismo que la primera respuesta.
 */
export function restoreCreateResponse(body: Prisma.JsonValue | null, current: OrderView): OrderView {
  const snapshot = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Prisma.JsonObject
    : undefined;
  const parseDate = (value: Prisma.JsonValue | undefined, fallback: Date): Date => {
    if (typeof value !== 'string') return fallback;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? fallback : date;
  };
  return {
    ...current,
    status: 'CONFIRMED',
    createdAt: parseDate(snapshot?.createdAt, current.createdAt),
    updatedAt: parseDate(snapshot?.updatedAt, current.createdAt),
    cancelledAt: null,
  };
}

/** Error público guardado (`{code, message}` + status) para repetirlo en cada reintento. */
export function storedFailure(status: number | null, body: Prisma.JsonValue | null): ApiError {
  const fallback = new ApiError(500, 'INTERNAL_ERROR', 'An unexpected internal error occurred');
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fallback;
  const code = body.code;
  const message = body.message;
  if (typeof code !== 'string' || typeof message !== 'string') return fallback;
  return new ApiError(status ?? 500, code, message);
}
