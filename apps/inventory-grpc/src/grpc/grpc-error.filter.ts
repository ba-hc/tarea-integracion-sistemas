import { Catch, type RpcExceptionFilter } from '@nestjs/common';
import { GrpcException, GrpcStatus, type GrpcExceptionBody } from '@nestjs/microservices';
import { throwError, type Observable } from 'rxjs';
import {
  InsufficientStockError,
  InvalidArgumentError,
  OrderIdConflictError,
  PartNotFoundError,
  PartsNotFoundError,
  ReservationAlreadyReleasedError,
  ReservationNotFoundError,
} from '../common/inventory-errors.js';

// Error de dominio -> estado gRPC. Espejo de la tabla "Estados gRPC de
// Inventory" en ERROR-MAPPING.md.
const STATUS_BY_ERROR: ReadonlyArray<readonly [abstract new (...args: never[]) => Error, GrpcStatus]> = [
  [InvalidArgumentError, GrpcStatus.INVALID_ARGUMENT],
  [PartNotFoundError, GrpcStatus.NOT_FOUND],
  [PartsNotFoundError, GrpcStatus.NOT_FOUND],
  [InsufficientStockError, GrpcStatus.FAILED_PRECONDITION],
  [OrderIdConflictError, GrpcStatus.ALREADY_EXISTS],
  // Estados terminales documentados en ERROR-MAPPING.md.
  [ReservationNotFoundError, GrpcStatus.NOT_FOUND],
  [ReservationAlreadyReleasedError, GrpcStatus.FAILED_PRECONDITION],
];

export const INTERNAL_ERROR: GrpcExceptionBody = { code: GrpcStatus.INTERNAL, message: 'Internal error' };

/**
 * Único punto de traducción error -> estado gRPC (ERROR-MAPPING.md).
 *
 * Todo lo que no sea un error conocido se responde como INTERNAL con un
 * mensaje genérico: el detalle (SQL, Prisma, stack) nunca llega al llamador.
 * El registro del detalle lo hace GrpcLoggingInterceptor, junto al traceId.
 */
export function toGrpcError(exception: unknown): GrpcExceptionBody {
  for (const [errorType, code] of STATUS_BY_ERROR) {
    if (exception instanceof errorType) {
      return { code, message: exception.message };
    }
  }
  if (exception instanceof GrpcException) {
    return exception.getError();
  }
  return INTERNAL_ERROR;
}

/** Sin este filtro Nest respondería UNKNOWN ante cualquier error. */
@Catch()
export class GrpcErrorFilter implements RpcExceptionFilter<unknown> {
  catch(exception: unknown): Observable<GrpcExceptionBody> {
    return throwError(() => toGrpcError(exception));
  }
}
