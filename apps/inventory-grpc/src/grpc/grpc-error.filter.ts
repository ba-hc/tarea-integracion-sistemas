import { Catch, Logger, type RpcExceptionFilter } from '@nestjs/common';
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
  // PROVISORIOS: casos no definidos en ERROR-MAPPING.md, pendientes de acordar con Sales.
  [ReservationNotFoundError, GrpcStatus.NOT_FOUND],
  [ReservationAlreadyReleasedError, GrpcStatus.FAILED_PRECONDITION],
];

/**
 * Único punto de traducción error -> estado gRPC (ERROR-MAPPING.md).
 *
 * Todo lo que no sea un error de dominio conocido se responde como INTERNAL
 * con un mensaje genérico: el detalle (SQL, Prisma, stack) sólo va al log, no
 * al llamador. Sin este filtro Nest respondería UNKNOWN.
 */
@Catch()
export class GrpcErrorFilter implements RpcExceptionFilter<unknown> {
  private readonly logger = new Logger(GrpcErrorFilter.name);

  catch(exception: unknown): Observable<GrpcExceptionBody> {
    return throwError(() => this.toGrpcError(exception));
  }

  toGrpcError(exception: unknown): GrpcExceptionBody {
    for (const [errorType, code] of STATUS_BY_ERROR) {
      if (exception instanceof errorType) {
        return { code, message: exception.message };
      }
    }
    if (exception instanceof GrpcException) {
      return exception.getError();
    }

    this.logger.error(
      'unexpected error while handling gRPC call',
      exception instanceof Error ? exception.stack : String(exception),
    );
    return { code: GrpcStatus.INTERNAL, message: 'Internal error' };
  }
}
