import { createHash } from 'node:crypto';
import { InvalidArgumentError } from '../common/inventory-errors.js';
import { isUuid } from '../common/uuid.js';
import type { ReleaseStockRequest, ReserveStockRequest } from '../grpc/inventory.proto-types.js';

// Límites de SYSTEM-DESIGN.md ("Reglas de datos").
export const MAX_ITEMS_PER_ORDER = 50;
export const MIN_QUANTITY = 1;
export const MAX_QUANTITY = 999;

export interface ReserveItem {
  partId: string;
  quantity: number;
}

/** ReserveStock ya validado. Los UUID van en minúsculas; los ítems, en el orden de la solicitud. */
export interface ReserveCommand {
  orderId: string;
  items: ReserveItem[];
}

function parseUuid(value: unknown, field: string): string {
  if (!isUuid(value)) {
    throw new InvalidArgumentError(`${field} must be a UUID`);
  }
  // PostgreSQL trata los UUID sin distinguir mayúsculas; normalizar aquí hace
  // que la detección de duplicados y la huella de la solicitud también lo hagan.
  return value.toLowerCase();
}

export function parseReserveRequest(request: ReserveStockRequest): ReserveCommand {
  const orderId = parseUuid(request.order_id, 'order_id');
  const rawItems = request.items ?? [];

  if (rawItems.length === 0) {
    throw new InvalidArgumentError('items must not be empty');
  }
  if (rawItems.length > MAX_ITEMS_PER_ORDER) {
    throw new InvalidArgumentError(`items must contain at most ${MAX_ITEMS_PER_ORDER} parts`);
  }

  const seen = new Set<string>();
  const items = rawItems.map((item, index) => {
    const partId = parseUuid(item.part_id, `items[${index}].part_id`);
    if (seen.has(partId)) {
      throw new InvalidArgumentError(`items[${index}].part_id is duplicated`);
    }
    seen.add(partId);

    const { quantity } = item;
    if (!Number.isInteger(quantity) || quantity < MIN_QUANTITY || quantity > MAX_QUANTITY) {
      throw new InvalidArgumentError(`items[${index}].quantity must be between ${MIN_QUANTITY} and ${MAX_QUANTITY}`);
    }
    return { partId, quantity };
  });

  return { orderId, items };
}

export function parseReleaseRequest(request: ReleaseStockRequest): string {
  return parseUuid(request.order_id, 'order_id');
}

/**
 * Huella de una reserva: sha256 de los ítems ordenados por part_id. El orden
 * en que Sales envía los ítems no cambia la huella; cualquier cambio de pieza
 * o cantidad sí.
 */
export function requestFingerprint(items: readonly ReserveItem[]): string {
  const canonical = [...items]
    .sort((a, b) => (a.partId < b.partId ? -1 : a.partId > b.partId ? 1 : 0))
    .map((item) => [item.partId, item.quantity]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
