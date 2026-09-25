import type { ReserveStockResponse } from '../grpc/inventory.proto-types.js';
import { toProtoTimestamp } from '../grpc/timestamp.js';
import type { StockOperationResult } from './stock.service.js';

/**
 * Resultado de ReserveStock/ReleaseStock -> mensaje del contrato.
 *
 * `part` es la foto de la pieza justo después de este movimiento:
 * stock_available = stock_after y updated_at = processed_at. Así un replay
 * devuelve exactamente lo mismo que la respuesta original.
 */
export function toStockResponse(result: StockOperationResult): ReserveStockResponse {
  const processedAt = toProtoTimestamp(result.processedAt);
  return {
    order_id: result.orderId,
    items: result.items.map((item) => ({
      part: {
        id: item.partId,
        sku: item.partSku,
        name: item.partName,
        stock_available: item.stockAfter,
        updated_at: processedAt,
      },
      quantity: item.quantity,
      stock_before: item.stockBefore,
      stock_after: item.stockAfter,
    })),
    processed_at: processedAt,
    replayed: result.replayed,
  };
}
