// Errores de dominio de Inventory. No conocen gRPC: la traducción a estados
// gRPC vive en un solo lugar (grpc/grpc-error.filter.ts), siguiendo la tabla
// de docs/architecture/ERROR-MAPPING.md.

export abstract class InventoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Solicitud mal formada: UUID inválido, cantidades fuera de rango, etc. */
export class InvalidArgumentError extends InventoryError {}

/** La pieza solicitada no existe en el catálogo. */
export class PartNotFoundError extends InventoryError {
  constructor(readonly partId: string) {
    super(`part ${partId} not found`);
  }
}
