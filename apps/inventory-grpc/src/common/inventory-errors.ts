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

/** Una o más piezas de la orden no existen. Se informan todas juntas. */
export class PartsNotFoundError extends InventoryError {
  constructor(readonly partIds: readonly string[]) {
    super(`parts not found: ${partIds.join(', ')}`);
  }
}

export interface StockShortage {
  partId: string;
  requested: number;
  available: number;
}

/** Stock insuficiente para una o más líneas. Se informan todas juntas. */
export class InsufficientStockError extends InventoryError {
  constructor(readonly shortages: readonly StockShortage[]) {
    super(
      'insufficient stock: ' +
        shortages.map((s) => `${s.partId} (requested ${s.requested}, available ${s.available})`).join(', '),
    );
  }
}

/** El order_id ya tiene una reserva con ítems distintos. */
export class OrderIdConflictError extends InventoryError {
  constructor(readonly orderId: string) {
    super(`order ${orderId} already has a reservation with a different payload`);
  }
}

// Los casos de reserva ausente o ya liberada están definidos en
// docs/architecture/ERROR-MAPPING.md.

/** ReleaseStock de un order_id que nunca se reservó. */
export class ReservationNotFoundError extends InventoryError {
  constructor(readonly orderId: string) {
    super(`no reservation found for order ${orderId}`);
  }
}

/** ReserveStock de un order_id cuya reserva ya fue liberada. */
export class ReservationAlreadyReleasedError extends InventoryError {
  constructor(readonly orderId: string) {
    super(`reservation for order ${orderId} was already released`);
  }
}
