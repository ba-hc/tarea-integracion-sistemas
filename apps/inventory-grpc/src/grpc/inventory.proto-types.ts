// Forma en JS de los mensajes de inventory.proto tal como los entrega
// @grpc/proto-loader con las opciones de INVENTORY_PROTO_LOADER_OPTIONS
// (keepCase: los nombres de campo son idénticos al contrato).
// Si el .proto cambia, estos tipos deben cambiar con él.

export const INVENTORY_PACKAGE = 'repuestossur.inventory.v1';
export const INVENTORY_SERVICE = 'InventoryService';

export const INVENTORY_PROTO_LOADER_OPTIONS = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
};

/** google.protobuf.Timestamp. `seconds` es int64: llega como string al decodificar. */
export interface ProtoTimestamp {
  seconds: number | string;
  nanos: number;
}

export interface ProtoPart {
  id: string;
  sku: string;
  name: string;
  stock_available: number;
  updated_at: ProtoTimestamp;
}

export interface GetPartRequest {
  part_id: string;
}

export interface GetPartResponse {
  part: ProtoPart;
}

export type ListPartsRequest = Record<string, never>;

export interface ListPartsResponse {
  parts: ProtoPart[];
}
