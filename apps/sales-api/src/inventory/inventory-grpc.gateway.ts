import { Metadata, type CallOptions } from '@grpc/grpc-js';
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { SALES_CONFIG, type SalesConfig } from '../config/app-config.js';
import { grpcStatusName, toInventoryApiError, type InventoryOperation } from './inventory-error.js';
import { INVENTORY_SERVICE_CLIENT, type InventoryServiceClient, type UnaryMethod } from './inventory-service-client.js';
import {
  type GetPartRequest,
  type GetPartResponse,
  type ListPartsRequest,
  type ListPartsResponse,
  type ReleaseStockRequest,
  type ReleaseStockResponse,
  type ReserveStockRequest,
  type ReserveStockResponse,
} from './inventory.proto-types.js';
import {
  INVENTORY_GATEWAY,
  type InventoryGateway,
  type PartSnapshot,
  type ReservedStockItem,
  type ReserveStockItem,
} from './inventory.gateway.js';

/** Metadata de correlación que Inventory ya reconoce; no forma parte del .proto. */
const TRACE_ID_METADATA_KEY = 'x-trace-id';

/**
 * Mismo patrón que acepta Inventory. Un traceId acotado a estos caracteres no
 * puede inyectar líneas en los logs; si el valor recibido no cumple, la llamada
 * viaja sin el header y Inventory genera su propio identificador.
 */
const TRACE_ID_PATTERN = /^[\w.:-]{1,128}$/;

/** Respuesta OK sin cuerpo: incumple el contrato y se traduce como falla interna. */
const EMPTY_RESPONSE_MESSAGE = 'inventory gRPC call returned no response';

/** Nombres de las RPC que se registran en los logs, tal como en el .proto. */
type InventoryRpcName = 'GetPart' | 'ListParts' | 'ReserveStock' | 'ReleaseStock';

/**
 * La traducción de los estados ambiguos depende de la llamada (ver
 * inventory-error.ts): liberar una orden reutiliza el order_id que ya validó
 * Sales, mientras que reservar o leer reciben identificadores del llamador.
 */
const OPERATION_BY_RPC: Readonly<Record<InventoryRpcName, InventoryOperation>> = {
  GetPart: 'read',
  ListParts: 'read',
  ReserveStock: 'reserve',
  ReleaseStock: 'release',
};

/** Identificadores de la llamada que se registran; nunca el payload completo. */
interface InventoryCallContext {
  orderId?: string;
  partId?: string;
}

/**
 * Adaptador gRPC de InventoryGateway: única parte de Sales que conoce
 * `@grpc/grpc-js`, el `.proto` y los códigos de estado gRPC.
 *
 * Aplica el deadline configurado a cada RPC (mutaciones y lecturas, según
 * RELIABILITY.md), propaga el traceId de la solicitud REST y no reintenta: cada
 * llamada del gateway es exactamente una RPC (ADR-004). Las fallas se traducen
 * al envelope congelado con textos fijos, sin propagar nunca el mensaje del
 * servidor.
 */
@Injectable()
export class InventoryGrpcGateway implements InventoryGateway, OnModuleDestroy {
  private readonly logger = new Logger('InventoryGateway');

  constructor(
    @Inject(INVENTORY_SERVICE_CLIENT) private readonly client: InventoryServiceClient,
    // Sólo consume el deadline: el resto de la configuración es de otros módulos.
    @Inject(SALES_CONFIG) private readonly config: Pick<SalesConfig, 'inventoryRpcDeadlineMs'>,
  ) {}

  async reserve(orderId: string, items: ReserveStockItem[], traceId: string): Promise<ReservedStockItem[]> {
    const response = await this.invoke<ReserveStockRequest, ReserveStockResponse>(
      this.client.ReserveStock,
      'ReserveStock',
      { order_id: orderId, items: items.map((item) => ({ part_id: item.partId, quantity: item.quantity })) },
      { orderId },
      traceId,
    );

    // Snapshot histórico de la pieza: Sales lo persiste con el ítem de la orden.
    return response.items.map((item) => ({
      partId: item.part.id,
      sku: item.part.sku,
      name: item.part.name,
      quantity: item.quantity,
    }));
  }

  async release(orderId: string, traceId: string): Promise<void> {
    await this.invoke<ReleaseStockRequest, ReleaseStockResponse>(
      this.client.ReleaseStock,
      'ReleaseStock',
      { order_id: orderId },
      { orderId },
      traceId,
    );
  }

  /** Lectura informativa: nunca autoriza una venta por sí sola (RELIABILITY.md). */
  async getPart(partId: string, traceId: string): Promise<PartSnapshot> {
    const response = await this.invoke<GetPartRequest, GetPartResponse>(
      this.client.GetPart,
      'GetPart',
      { part_id: partId },
      { partId },
      traceId,
    );

    return {
      partId: response.part.id,
      sku: response.part.sku,
      name: response.part.name,
      stockAvailable: response.part.stock_available,
    };
  }

  /** Lectura informativa: nunca autoriza una venta por sí sola (RELIABILITY.md). */
  async listParts(traceId: string): Promise<PartSnapshot[]> {
    const response = await this.invoke<ListPartsRequest, ListPartsResponse>(
      this.client.ListParts,
      'ListParts',
      {}, // ListPartsRequest vacío por contrato
      {}, // sin orderId ni partId que correlacionar en el log
      traceId,
    );

    return response.parts.map((part) => ({
      partId: part.id,
      sku: part.sku,
      name: part.name,
      stockAvailable: part.stock_available,
    }));
  }

  /** El canal se cierra con el módulo; no debe quedar ningún cliente vivo tras el apagado. */
  onModuleDestroy(): void {
    this.client.close();
  }

  /**
   * Una RPC unaria con deadline y traducción de errores. El registro incluye
   * método, estado, duración, traceId y el identificador de la llamada
   * (orderId o partId): nunca el payload ni el mensaje del servidor.
   */
  private invoke<Request, Response>(
    rpc: UnaryMethod<Request, Response>,
    method: InventoryRpcName,
    request: Request,
    context: InventoryCallContext,
    traceId: string,
  ): Promise<Response> {
    const trimmedTraceId = traceId.trim();
    const safeTraceId = TRACE_ID_PATTERN.test(trimmedTraceId) ? trimmedTraceId : undefined;

    const metadata = new Metadata();
    if (safeTraceId !== undefined) {
      metadata.set(TRACE_ID_METADATA_KEY, safeTraceId);
    }

    const options: CallOptions = { deadline: Date.now() + this.config.inventoryRpcDeadlineMs };
    const startedAt = performance.now();

    return new Promise<Response>((resolve, reject) => {
      // El método generado se invoca con el cliente como receptor.
      rpc.call(this.client, request, metadata, options, (error, response) => {
        const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;

        if (error !== null || response === undefined) {
          const failure: unknown = error ?? new Error(EMPTY_RESPONSE_MESSAGE);
          const apiError = toInventoryApiError(failure, OPERATION_BY_RPC[method]);
          const httpStatus = apiError.getStatus();
          const fields = {
            method,
            status: grpcStatusName(failure),
            httpStatus,
            durationMs,
            traceId: safeTraceId,
            ...context,
          };
          // 5xx es una falla del servicio o de su dependencia; 4xx es un rechazo
          // de negocio que el llamador puede corregir.
          if (httpStatus >= 500) {
            this.logger.error('inventory gRPC call failed', fields);
          } else {
            this.logger.warn('inventory gRPC call rejected', fields);
          }
          reject(apiError);
          return;
        }

        this.logger.log('inventory gRPC call completed', {
          method,
          status: 'OK',
          durationMs,
          traceId: safeTraceId,
          ...context,
        });
        resolve(response);
      });
    });
  }
}
