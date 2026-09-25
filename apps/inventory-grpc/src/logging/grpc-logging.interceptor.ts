import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { GrpcStatus } from '@nestjs/microservices';
import { tap, type Observable } from 'rxjs';
import { INTERNAL_ERROR, toGrpcError } from '../grpc/grpc-error.filter.js';
import { redactSecrets } from './logger.js';

/**
 * Metadata gRPC opcional con la que el llamador puede correlacionar sus logs
 * con los de Inventory (p. ej. Sales envía el traceId de la solicitud REST).
 * No forma parte del .proto: si no viene, se genera uno.
 */
export const TRACE_ID_METADATA_KEY = 'x-trace-id';

interface GrpcMetadataLike {
  get(key: string): Array<string | Buffer>;
}

interface IdentifiableRequest {
  order_id?: unknown;
  part_id?: unknown;
  items?: unknown;
}

function readTraceId(metadata: GrpcMetadataLike | undefined): string {
  const value = metadata?.get(TRACE_ID_METADATA_KEY)[0];
  const traceId = typeof value === 'string' ? value.trim() : '';
  // Acotado para que un llamador no pueda inyectar líneas o textos enormes en el log.
  return /^[\w.:-]{1,128}$/.test(traceId) ? traceId : randomUUID();
}

/** Identificadores útiles para buscar una llamada. Nunca el payload completo. */
function describeRequest(request: IdentifiableRequest | undefined): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (typeof request?.order_id === 'string' && request.order_id) {
    fields.orderId = request.order_id.slice(0, 64);
  }
  if (typeof request?.part_id === 'string' && request.part_id) {
    fields.partId = request.part_id.slice(0, 64);
  }
  if (Array.isArray(request?.items)) {
    fields.itemCount = request.items.length;
  }
  return fields;
}

/**
 * Registra una línea por llamada gRPC: método, resultado (código gRPC),
 * duración, traceId e ids de negocio. Los errores inesperados se registran con
 * su stack (sin credenciales) y el mismo traceId; al llamador sólo le llega
 * INTERNAL (ver GrpcErrorFilter).
 */
@Injectable()
export class GrpcLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('GrpcCall');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const rpc = context.switchToRpc();
    // Los handlers se llaman como la RPC en camelCase (reserveStock -> ReserveStock).
    const handlerName = context.getHandler().name;
    const method = handlerName.charAt(0).toUpperCase() + handlerName.slice(1);
    const traceId = readTraceId(rpc.getContext<GrpcMetadataLike>());
    const request = describeRequest(rpc.getData<IdentifiableRequest>());
    const startedAt = performance.now();
    const elapsed = () => Math.round((performance.now() - startedAt) * 10) / 10;

    return next.handle().pipe(
      tap({
        next: () => {
          this.logger.log('grpc call completed', { method, code: 'OK', durationMs: elapsed(), traceId, ...request });
        },
        error: (error: unknown) => {
          const { code } = toGrpcError(error);
          const fields = { method, code: GrpcStatus[code], durationMs: elapsed(), traceId, ...request };
          if (code === INTERNAL_ERROR.code) {
            const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
            this.logger.error('grpc call failed unexpectedly', { ...fields, error: redactSecrets(detail) });
          } else {
            // Errores esperados del llamador (validación, stock, etc.): no son fallas del servicio.
            this.logger.log('grpc call rejected', fields);
          }
        },
      }),
    );
  }
}
