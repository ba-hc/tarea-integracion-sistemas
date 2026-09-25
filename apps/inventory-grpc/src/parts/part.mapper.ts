import type { Part } from '../generated/prisma/client.js';
import type { ProtoPart } from '../grpc/inventory.proto-types.js';
import { toProtoTimestamp } from '../grpc/timestamp.js';

/** Fila de `parts` -> mensaje `Part` del contrato. `created_at` no se expone. */
export function toProtoPart(part: Part): ProtoPart {
  return {
    id: part.id,
    sku: part.sku,
    name: part.name,
    stock_available: part.stockAvailable,
    updated_at: toProtoTimestamp(part.updatedAt),
  };
}
