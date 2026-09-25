import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import type { SalesConfig } from '../config/app-config.js';
import {
  INVENTORY_LOADER_OPTIONS,
  INVENTORY_PACKAGE,
  INVENTORY_SERVICE,
  type GetPartRequest,
  type GetPartResponse,
  type ListPartsRequest,
  type ListPartsResponse,
  type ReleaseStockRequest,
  type ReleaseStockResponse,
  type ReserveStockRequest,
  type ReserveStockResponse,
} from './inventory.proto-types.js';

/** Token del cliente gRPC. Sólo lo consume InventoryGrpcGateway. */
export const INVENTORY_SERVICE_CLIENT = Symbol('INVENTORY_SERVICE_CLIENT');

/**
 * Firma de una RPC unaria del cliente generado por proto-loader + grpc-js
 * (`Client.prototype.makeUnaryRequest` con el método ya fijado).
 */
export type UnaryMethod<Request, Response> = (
  request: Request,
  metadata: grpc.Metadata,
  options: grpc.CallOptions,
  callback: grpc.requestCallback<Response>,
) => grpc.ClientUnaryCall;

/** Cliente del contrato `InventoryService`, con los nombres del .proto. */
export interface InventoryServiceClient {
  GetPart: UnaryMethod<GetPartRequest, GetPartResponse>;
  ListParts: UnaryMethod<ListPartsRequest, ListPartsResponse>;
  ReserveStock: UnaryMethod<ReserveStockRequest, ReserveStockResponse>;
  ReleaseStock: UnaryMethod<ReleaseStockRequest, ReleaseStockResponse>;
  close(): void;
}

export type InventoryServiceClientConstructor = new (
  address: string,
  credentials: grpc.ChannelCredentials,
  options?: grpc.ClientOptions,
) => InventoryServiceClient;

/**
 * Sin retries automáticos en v1 (ADR-004): el transporte no reintenta una
 * mutación a espaldas del llamador. Se desactiva explícitamente para que la
 * garantía no dependa de que el destino no publique una política de retry.
 */
const CLIENT_OPTIONS: grpc.ClientOptions = { 'grpc.enable_retries': 0 };

/**
 * Baja por el árbol de paquetes hasta la clase cliente de InventoryService.
 * proto-loader anida los servicios siguiendo el paquete del .proto; se confirma
 * que la ruta termina en una clase para fallar al arrancar (con un mensaje que
 * nombra el contrato) en vez de en la primera llamada.
 */
function resolveServiceConstructor(loaded: unknown): InventoryServiceClientConstructor {
  let scope: Record<string, unknown> | undefined = loaded as Record<string, unknown>;
  for (const segment of INVENTORY_PACKAGE.split('.')) {
    scope = scope?.[segment] as Record<string, unknown> | undefined;
  }
  const service: unknown = scope?.[INVENTORY_SERVICE];
  if (typeof service !== 'function') {
    throw new Error(`inventory proto does not define ${INVENTORY_PACKAGE}.${INVENTORY_SERVICE}`);
  }
  return service as InventoryServiceClientConstructor;
}

/**
 * Construye el cliente del .proto congelado en tiempo de ejecución, sin copiarlo
 * ni generar código: lo que se invoca es exactamente el contrato compartido.
 *
 * El canal se abre de forma perezosa en la primera RPC, así que este constructor
 * no requiere que Inventory esté arriba (Docker Compose puede arrancar Sales
 * primero) ni bloquea el arranque del proceso.
 */
export function createInventoryServiceClient(
  config: Pick<SalesConfig, 'inventoryGrpcUrl' | 'inventoryProtoPath'>,
): InventoryServiceClient {
  const definition = protoLoader.loadSync(config.inventoryProtoPath, INVENTORY_LOADER_OPTIONS);
  const ServiceClient = resolveServiceConstructor(grpc.loadPackageDefinition(definition));
  // Red privada de Compose sin TLS: el contrato gRPC v1 no define credenciales.
  return new ServiceClient(config.inventoryGrpcUrl, grpc.credentials.createInsecure(), CLIENT_OPTIONS);
}
