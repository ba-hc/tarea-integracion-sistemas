/**
 * Frontera de Sales hacia Inventory (ADR-001 / ADR-002).
 *
 * Los casos de uso de órdenes dependen de esta interfaz, nunca de
 * `@grpc/grpc-js` ni del `.proto`: el transporte vive en
 * `InventoryGrpcGateway` y se sustituye por una implementación falsa en las
 * pruebas de los flujos de orden sin tocar la orquestación.
 */
export const INVENTORY_GATEWAY = Symbol('INVENTORY_GATEWAY');

/** Ítem solicitado a Inventory: espejo de `StockItemRequest` del contrato gRPC. */
export interface ReserveStockItem {
  partId: string;
  quantity: number;
}

/**
 * Snapshot que Inventory devuelve por cada ítem reservado. `sku` y `name` son
 * los valores históricos que Sales persiste junto a la orden.
 */
export interface ReservedStockItem {
  partId: string;
  sku: string;
  name: string;
  quantity: number;
}

/**
 * Snapshot de una pieza de Inventory para uso interno de Sales. Los campos
 * siguen el vocabulario de Sales (no el de los mensajes protobuf) y nunca se
 * exponen tal cual por REST: Inventory no es visible para el cliente externo.
 */
export interface PartSnapshot {
  partId: string;
  sku: string;
  name: string;
  stockAvailable: number;
}

export interface InventoryGateway {
  /**
   * Reserva todos los ítems o ninguno. Idempotente por `orderId`: repetir la
   * misma reserva no descuenta stock dos veces (RELIABILITY.md).
   */
  reserve(orderId: string, items: ReserveStockItem[], traceId: string): Promise<ReservedStockItem[]>;

  /**
   * Repone exactamente lo reservado por `orderId`. Idempotente por `orderId`.
   */
  release(orderId: string, traceId: string): Promise<void>;

  /**
   * Pieza y stock disponible actuales. Lectura informativa: un valor leído aquí
   * nunca autoriza una venta (RELIABILITY.md); sólo `reserve` lo hace.
   */
  getPart(partId: string, traceId: string): Promise<PartSnapshot>;

  /** Inventario académico completo. Misma advertencia que `getPart`. */
  listParts(traceId: string): Promise<PartSnapshot[]>;
}
