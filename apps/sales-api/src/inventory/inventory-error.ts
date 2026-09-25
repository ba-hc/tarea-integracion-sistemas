import { status as GrpcStatus } from '@grpc/grpc-js';
import { ApiError } from '../common/api-error.js';

// Traducción gRPC -> REST del envelope congelado. Espejo de la tabla
// "Traducción de Sales para llamadas que mutan órdenes" de
// docs/architecture/ERROR-MAPPING.md, con una precisión que esa tabla no puede
// expresar: el mismo estado gRPC no significa lo mismo en todas las llamadas.
//
// Los mensajes son textos fijos de Sales: el mensaje del servidor (que puede
// traer SQL, detalles de Prisma o del ledger de stock) NUNCA se propaga al
// cliente ni se adjunta como `details`.

/** Llamada de Inventory de la que provino la falla. */
export type InventoryOperation = 'reserve' | 'release' | 'read';

interface ErrorMapping {
  status: number;
  code: string;
  message: string;
}

/** Falla inesperada de Sales y, también, todo estado gRPC no listado abajo. */
const INTERNAL: ErrorMapping = {
  status: 500,
  code: 'INTERNAL_ERROR',
  message: 'An unexpected internal error occurred',
};

const VALIDATION: ErrorMapping = {
  status: 400,
  code: 'VALIDATION_ERROR',
  message: 'Request validation failed',
};

const PART_NOT_FOUND: ErrorMapping = {
  status: 422,
  code: 'PART_NOT_FOUND',
  message: 'One or more requested parts do not exist',
};

/** Mismo significado en cualquier llamada. */
const SHARED: Readonly<Record<number, ErrorMapping>> = {
  // Mismo order_id reutilizado con otro payload: inconsistencia interna.
  [GrpcStatus.ALREADY_EXISTS]: INTERNAL,
  [GrpcStatus.UNAVAILABLE]: {
    status: 503,
    code: 'INVENTORY_UNAVAILABLE',
    message: 'Inventory service is unavailable',
  },
  [GrpcStatus.DEADLINE_EXCEEDED]: {
    status: 504,
    code: 'INVENTORY_TIMEOUT',
    message: 'Inventory service did not respond before the deadline',
  },
};

/**
 * Estados cuyo significado depende de la llamada.
 *
 * En `reserve` describen el payload que envió el llamador (UUID, pieza, stock),
 * así que se traducen a 400/422/409.
 *
 * En `release` el `order_id` y sus piezas provienen de la propia orden de Sales:
 * recibir cualquiera de esos rechazos significa que Sales e Inventory ya no
 * coinciden sobre el estado de esa orden. No es un error del llamador (y el
 * contrato REST de cancelación no admite 422), así que es una falla interna.
 *
 * En `read` el `partId` vuelve a venir del llamador, por lo que su rechazo sí es
 * una respuesta válida; `FAILED_PRECONDITION` (stock insuficiente) no pertenece
 * a una lectura y delata una inconsistencia.
 */
const PER_OPERATION: Readonly<Record<InventoryOperation, Readonly<Record<number, ErrorMapping>>>> = {
  reserve: {
    [GrpcStatus.INVALID_ARGUMENT]: VALIDATION,
    [GrpcStatus.NOT_FOUND]: PART_NOT_FOUND,
    [GrpcStatus.FAILED_PRECONDITION]: {
      status: 409,
      code: 'INSUFFICIENT_STOCK',
      message: 'One or more parts do not have enough stock',
    },
  },
  release: {
    [GrpcStatus.INVALID_ARGUMENT]: INTERNAL,
    [GrpcStatus.NOT_FOUND]: INTERNAL,
    [GrpcStatus.FAILED_PRECONDITION]: INTERNAL,
  },
  read: {
    [GrpcStatus.INVALID_ARGUMENT]: VALIDATION,
    [GrpcStatus.NOT_FOUND]: PART_NOT_FOUND,
    [GrpcStatus.FAILED_PRECONDITION]: INTERNAL,
  },
};

/** Código de estado gRPC del error, o `undefined` si no vino de gRPC. */
function grpcStatusOf(error: unknown): number | undefined {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'number' ? code : undefined;
}

/**
 * Nombre del estado gRPC para logs (`UNAVAILABLE`, `DEADLINE_EXCEEDED`...).
 * Un error que no viene de gRPC (un fallo de programación, por ejemplo) se
 * registra como `UNKNOWN`.
 */
export function grpcStatusName(error: unknown): string {
  const status = grpcStatusOf(error);
  return status === undefined ? 'UNKNOWN' : (GrpcStatus[status] ?? 'UNKNOWN');
}

/** Traduce una falla de la llamada a Inventory al error público de REST. */
export function toInventoryApiError(error: unknown, operation: InventoryOperation): ApiError {
  const status = grpcStatusOf(error);
  const mapping = (status === undefined ? undefined : (PER_OPERATION[operation][status] ?? SHARED[status])) ?? INTERNAL;
  return new ApiError(mapping.status, mapping.code, mapping.message);
}
