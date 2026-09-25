// Forma en JS de los mensajes de contracts/grpc/repuestossur/inventory/v1/inventory.proto
// que Sales consume, tal como los entrega @grpc/proto-loader con
// INVENTORY_LOADER_OPTIONS (keepCase: los nombres de campo son idénticos al
// contrato). El .proto está congelado; si cambia, estos tipos cambian con él.
//
// Sólo se declaran los campos que Sales usa: el .proto es la fuente de verdad
// de lo que viaja por el canal, no de lo que este servicio necesita leer.

import type { Options } from '@grpc/proto-loader';

export const INVENTORY_PACKAGE = 'repuestossur.inventory.v1';
export const INVENTORY_SERVICE = 'InventoryService';

export const INVENTORY_LOADER_OPTIONS: Options = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
};

/** Mensaje `StockItemRequest`. */
export interface StockItemRequest {
  part_id: string;
  quantity: number;
}

/** Mensaje `ReserveStockRequest`. `order_id` es el UUID generado por Sales. */
export interface ReserveStockRequest {
  order_id: string;
  items: StockItemRequest[];
}

/** Campos de `Part` que Sales consume. */
export interface ProtoPart {
  id: string;
  sku: string;
  name: string;
  stock_available: number;
}

/** Mensaje `GetPartRequest`. */
export interface GetPartRequest {
  part_id: string;
}

/** Mensaje `GetPartResponse`. */
export interface GetPartResponse {
  part: ProtoPart;
}

/** Mensaje `ListPartsRequest`: vacío por contrato. */
export type ListPartsRequest = Record<string, never>;

/** Mensaje `ListPartsResponse`. */
export interface ListPartsResponse {
  parts: ProtoPart[];
}

/** Mensaje `StockMutationItem`. */
export interface StockMutationItem {
  part: ProtoPart;
  quantity: number;
}

/** Mensaje `ReserveStockResponse`. */
export interface ReserveStockResponse {
  order_id: string;
  items: StockMutationItem[];
}

/** Mensaje `ReleaseStockRequest`. Inventory reconstruye la mutación de su propio ledger. */
export interface ReleaseStockRequest {
  order_id: string;
}

/** Mensaje `ReleaseStockResponse`: no aporta datos que Sales necesite. */
export interface ReleaseStockResponse {
  order_id: string;
}
