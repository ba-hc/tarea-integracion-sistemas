import { Catch, Logger, type RpcExceptionFilter } from '@nestjs/common';
import { GrpcException, GrpcStatus, type GrpcExceptionBody } from '@nestjs/microservices';
import { throwError, type Observable } from 'rxjs';
import { InvalidArgumentError, PartNotFoundError } from '../common/inventory-errors.js';

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
    if (exception instanceof InvalidArgumentError) {
      return { code: GrpcStatus.INVALID_ARGUMENT, message: exception.message };
    }
    if (exception instanceof PartNotFoundError) {
      return { code: GrpcStatus.NOT_FOUND, message: exception.message };
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
