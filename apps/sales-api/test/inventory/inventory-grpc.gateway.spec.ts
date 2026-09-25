import {
  Metadata,
  status as GrpcStatus,
  type CallOptions,
  type ClientUnaryCall,
  type requestCallback,
  type ServiceError,
} from '@grpc/grpc-js';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/common/api-error.js';
import type { SalesConfig } from '../../src/config/app-config.js';
import { InventoryGrpcGateway } from '../../src/inventory/inventory-grpc.gateway.js';
import type { InventoryServiceClient } from '../../src/inventory/inventory-service-client.js';
import type {
  GetPartRequest,
  GetPartResponse,
  ListPartsRequest,
  ListPartsResponse,
  ReleaseStockRequest,
  ReleaseStockResponse,
  ReserveStockRequest,
  ReserveStockResponse,
} from '../../src/inventory/inventory.proto-types.js';

const DEADLINE_MS = 800;
const CONFIG: Pick<SalesConfig, 'inventoryRpcDeadlineMs'> = { inventoryRpcDeadlineMs: DEADLINE_MS };
const TRACE_ID = '73a9be64-6e7e-42c2-badc-55f42f649668';
const ORDER_ID = 'f5c1b0f2-4d1e-4f6a-9c2b-6f9f0f1c2d3e';

const BUJIA = { id: 'd6e1fd98-cb07-458f-aa12-6fe220b37604', sku: 'MOT-BUJ-IRI-009', name: 'Bujía de iridio' };
const FILTRO = { id: '9a7c5e33-2b41-4f8e-8d1c-3e5a7b9c1d2f', sku: 'FIL-ACE-TOY-001', name: 'Filtro de aceite' };

/** Piezas tal como las entrega el .proto (keepCase + defaults). */
const PROTO_BUJIA = { ...BUJIA, stock_available: 198 };
const PROTO_FILTRO = { ...FILTRO, stock_available: 7 };

/** Respuesta del contrato para dos ítems reservados. */
const RESERVED: ReserveStockResponse = {
  order_id: ORDER_ID,
  items: [
    { part: PROTO_BUJIA, quantity: 2 },
    { part: PROTO_FILTRO, quantity: 1 },
  ],
};

const RAW_DETAIL = 'SQLSTATE 23505: duplicate key value violates unique constraint "stock_operations_order_id_key"';

/** Falla tal como la entrega grpc-js en el callback de una RPC unaria. */
function grpcError(code: GrpcStatus, message: string, details = ''): ServiceError {
  return Object.assign(new Error(message), { code, details, metadata: new Metadata() });
}

interface RecordedCall {
  method: 'GetPart' | 'ListParts' | 'ReserveStock' | 'ReleaseStock';
  request: unknown;
  metadata: Metadata;
  options: CallOptions | undefined;
}

interface LogRecord {
  level: 'log' | 'warn' | 'error';
  message: unknown;
  fields: unknown;
}

/**
 * Cliente gRPC falso. Registra las llamadas sobre `this` a propósito: si el
 * gateway invocara el método desligado del cliente (perdiera el receptor), la
 * prueba fallaría en vez de pasar por casualidad.
 */
class FakeInventoryServiceClient implements InventoryServiceClient {
  readonly calls: RecordedCall[] = [];
  closed = false;
  /** Resultado de la próxima RPC: `error` gana sobre `response`. */
  reply: { error: ServiceError | null; response?: unknown } = { error: null };

  GetPart(
    request: GetPartRequest,
    metadata: Metadata,
    options: CallOptions,
    callback: requestCallback<GetPartResponse>,
  ): ClientUnaryCall {
    return this.respond('GetPart', request, metadata, options, callback);
  }

  ListParts(
    request: ListPartsRequest,
    metadata: Metadata,
    options: CallOptions,
    callback: requestCallback<ListPartsResponse>,
  ): ClientUnaryCall {
    return this.respond('ListParts', request, metadata, options, callback);
  }

  ReserveStock(
    request: ReserveStockRequest,
    metadata: Metadata,
    options: CallOptions,
    callback: requestCallback<ReserveStockResponse>,
  ): ClientUnaryCall {
    return this.respond('ReserveStock', request, metadata, options, callback);
  }

  ReleaseStock(
    request: ReleaseStockRequest,
    metadata: Metadata,
    options: CallOptions,
    callback: requestCallback<ReleaseStockResponse>,
  ): ClientUnaryCall {
    return this.respond('ReleaseStock', request, metadata, options, callback);
  }

  close(): void {
    this.closed = true;
  }

  private respond<Response>(
    method: RecordedCall['method'],
    request: unknown,
    metadata: Metadata,
    options: CallOptions,
    callback: requestCallback<Response>,
  ): ClientUnaryCall {
    this.calls.push({ method, request, metadata, options });
    callback(this.reply.error, this.reply.response as Response | undefined);
    return {} as ClientUnaryCall;
  }
}

/**
 * Captura los campos estructurados del logger de Nest. Se espía el prototipo
 * porque Logger delega cada método a su instancia interna.
 */
function recordLogs(): LogRecord[] {
  const records: LogRecord[] = [];
  const capture = (level: LogRecord['level']) => (message: unknown, ...params: unknown[]) => {
    records.push({ level, message, fields: params[0] });
  };
  vi.spyOn(Logger.prototype, 'log').mockImplementation(capture('log'));
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(capture('warn'));
  vi.spyOn(Logger.prototype, 'error').mockImplementation(capture('error'));
  return records;
}

/** Devuelve el error público con el que falló la llamada. */
async function captureFailure(promise: Promise<unknown>): Promise<ApiError> {
  const failure: unknown = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(ApiError);
  return failure as ApiError;
}

/** [estado gRPC, HTTP esperado, código público esperado] */
type FailureCase = [code: GrpcStatus, status: number, errorCode: string];

const FAILURES: FailureCase[] = [
  [GrpcStatus.INVALID_ARGUMENT, 400, 'VALIDATION_ERROR'],
  [GrpcStatus.NOT_FOUND, 422, 'PART_NOT_FOUND'],
  [GrpcStatus.FAILED_PRECONDITION, 409, 'INSUFFICIENT_STOCK'],
  // Inconsistencia interna de order_id: el llamador no puede corregirla.
  [GrpcStatus.ALREADY_EXISTS, 500, 'INTERNAL_ERROR'],
  [GrpcStatus.INTERNAL, 500, 'INTERNAL_ERROR'],
  [GrpcStatus.PERMISSION_DENIED, 500, 'INTERNAL_ERROR'],
];

describe('InventoryGrpcGateway', () => {
  let client: FakeInventoryServiceClient;
  let gateway: InventoryGrpcGateway;
  let logs: LogRecord[];

  beforeEach(() => {
    client = new FakeInventoryServiceClient();
    gateway = new InventoryGrpcGateway(client, CONFIG);
    logs = recordLogs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('reserve', () => {
    it('envía los ítems con los nombres del .proto y devuelve los snapshots de pieza', async () => {
      client.reply = { error: null, response: RESERVED };

      const items = await gateway.reserve(
        ORDER_ID,
        [
          { partId: BUJIA.id, quantity: 2 },
          { partId: FILTRO.id, quantity: 1 },
        ],
        TRACE_ID,
      );

      expect(items).toEqual([
        { partId: BUJIA.id, sku: BUJIA.sku, name: BUJIA.name, quantity: 2 },
        { partId: FILTRO.id, sku: FILTRO.sku, name: FILTRO.name, quantity: 1 },
      ]);
      expect(client.calls).toHaveLength(1);
      expect(client.calls[0]?.method).toBe('ReserveStock');
      expect(client.calls[0]?.request).toEqual({
        order_id: ORDER_ID,
        items: [
          { part_id: BUJIA.id, quantity: 2 },
          { part_id: FILTRO.id, quantity: 1 },
        ],
      });
    });

    it('propaga el traceId en la metadata x-trace-id y aplica el deadline configurado', async () => {
      client.reply = { error: null, response: RESERVED };
      const before = Date.now();

      await gateway.reserve(ORDER_ID, [{ partId: BUJIA.id, quantity: 1 }], TRACE_ID);

      const call = client.calls[0];
      expect(call?.metadata.get('x-trace-id')).toEqual([TRACE_ID]);
      const deadline = call?.options?.deadline;
      expect(typeof deadline).toBe('number');
      expect(deadline as number).toBeGreaterThanOrEqual(before + DEADLINE_MS);
      expect(deadline as number).toBeLessThanOrEqual(Date.now() + DEADLINE_MS);
    });

    it('sin un traceId seguro la llamada viaja sin metadata de correlación', async () => {
      client.reply = { error: null, response: RESERVED };

      await gateway.reserve(ORDER_ID, [{ partId: BUJIA.id, quantity: 1 }], 'con salto\nde línea');

      expect(client.calls[0]?.metadata.get('x-trace-id')).toEqual([]);
    });

    it.each(FAILURES)('traduce %s a %i %s sin propagar el mensaje de Inventory', async (code, status, errorCode) => {
      client.reply = { error: grpcError(code, RAW_DETAIL) };

      const failure = await captureFailure(gateway.reserve(ORDER_ID, [{ partId: BUJIA.id, quantity: 1 }], TRACE_ID));

      expect({ status: failure.getStatus(), code: failure.code }).toEqual({ status, code: errorCode });
      expect(JSON.stringify(failure)).not.toContain('SQLSTATE');
      // Exactamente una RPC: el transporte no reintenta (ADR-004).
      expect(client.calls).toHaveLength(1);
    });

    it('traduce UNAVAILABLE a 503 INVENTORY_UNAVAILABLE', async () => {
      client.reply = { error: grpcError(GrpcStatus.UNAVAILABLE, 'No connection established. Last error: ECONNREFUSED') };

      const failure = await captureFailure(gateway.reserve(ORDER_ID, [{ partId: BUJIA.id, quantity: 1 }], TRACE_ID));

      expect({ status: failure.getStatus(), code: failure.code, message: failure.message }).toEqual({
        status: 503,
        code: 'INVENTORY_UNAVAILABLE',
        message: 'Inventory service is unavailable',
      });
      expect(client.calls).toHaveLength(1);
    });

    it('traduce DEADLINE_EXCEEDED a 504 INVENTORY_TIMEOUT', async () => {
      client.reply = { error: grpcError(GrpcStatus.DEADLINE_EXCEEDED, 'Deadline exceeded after 799.33ms') };

      const failure = await captureFailure(gateway.reserve(ORDER_ID, [{ partId: BUJIA.id, quantity: 1 }], TRACE_ID));

      expect({ status: failure.getStatus(), code: failure.code, message: failure.message }).toEqual({
        status: 504,
        code: 'INVENTORY_TIMEOUT',
        message: 'Inventory service did not respond before the deadline',
      });
      expect(client.calls).toHaveLength(1);
    });

    it('trata una respuesta sin cuerpo como 500 INTERNAL_ERROR', async () => {
      client.reply = { error: null, response: undefined };

      const failure = await captureFailure(gateway.reserve(ORDER_ID, [{ partId: BUJIA.id, quantity: 1 }], TRACE_ID));

      expect({ status: failure.getStatus(), code: failure.code }).toEqual({ status: 500, code: 'INTERNAL_ERROR' });
    });

    it('registra método, estado, duración, traceId y orderId sin el payload', async () => {
      client.reply = { error: null, response: RESERVED };

      await gateway.reserve(ORDER_ID, [{ partId: BUJIA.id, quantity: 2 }], TRACE_ID);

      expect(logs).toHaveLength(1);
      expect(logs[0]?.level).toBe('log');
      expect(logs[0]?.message).toBe('inventory gRPC call completed');
      const fields = logs[0]?.fields as Record<string, unknown>;
      expect(Object.keys(fields).sort()).toEqual(['durationMs', 'method', 'orderId', 'status', 'traceId']);
      expect(fields).toMatchObject({ method: 'ReserveStock', status: 'OK', traceId: TRACE_ID, orderId: ORDER_ID });
      expect(fields.durationMs).toBeTypeOf('number');
    });

    it('registra la falla de dependencia sin el mensaje del servidor', async () => {
      client.reply = { error: grpcError(GrpcStatus.UNAVAILABLE, RAW_DETAIL) };

      await captureFailure(gateway.reserve(ORDER_ID, [{ partId: BUJIA.id, quantity: 1 }], TRACE_ID));

      expect(logs).toHaveLength(1);
      expect(logs[0]?.level).toBe('error');
      expect(logs[0]?.message).toBe('inventory gRPC call failed');
      const fields = logs[0]?.fields as Record<string, unknown>;
      expect(Object.keys(fields).sort()).toEqual(['durationMs', 'httpStatus', 'method', 'orderId', 'status', 'traceId']);
      expect(fields).toMatchObject({
        method: 'ReserveStock',
        status: 'UNAVAILABLE',
        httpStatus: 503,
        traceId: TRACE_ID,
        orderId: ORDER_ID,
      });
      expect(JSON.stringify(logs)).not.toContain('SQLSTATE');
    });

    it('registra un rechazo de negocio como advertencia', async () => {
      client.reply = { error: grpcError(GrpcStatus.FAILED_PRECONDITION, 'insufficient stock') };

      await captureFailure(gateway.reserve(ORDER_ID, [{ partId: BUJIA.id, quantity: 5 }], TRACE_ID));

      expect(logs.map((entry) => entry.level)).toEqual(['warn']);
      expect((logs[0]?.fields as Record<string, unknown>).status).toBe('FAILED_PRECONDITION');
    });
  });

  describe('release', () => {
    it('libera por order_id y resuelve sin cuerpo', async () => {
      client.reply = { error: null, response: { order_id: ORDER_ID } };

      await expect(gateway.release(ORDER_ID, TRACE_ID)).resolves.toBeUndefined();

      expect(client.calls).toHaveLength(1);
      expect(client.calls[0]?.method).toBe('ReleaseStock');
      expect(client.calls[0]?.request).toEqual({ order_id: ORDER_ID });
      expect(client.calls[0]?.metadata.get('x-trace-id')).toEqual([TRACE_ID]);
      expect(logs[0]?.message).toBe('inventory gRPC call completed');
    });

    it('traduce DEADLINE_EXCEEDED a 504 INVENTORY_TIMEOUT', async () => {
      client.reply = { error: grpcError(GrpcStatus.DEADLINE_EXCEEDED, 'Deadline exceeded after 799.33ms') };

      const failure = await captureFailure(gateway.release(ORDER_ID, TRACE_ID));

      expect({ status: failure.getStatus(), code: failure.code }).toEqual({ status: 504, code: 'INVENTORY_TIMEOUT' });
      expect(client.calls).toHaveLength(1);
    });

    it('conserva 503 INVENTORY_UNAVAILABLE', async () => {
      client.reply = { error: grpcError(GrpcStatus.UNAVAILABLE, 'No connection established') };

      const failure = await captureFailure(gateway.release(ORDER_ID, TRACE_ID));

      expect({ status: failure.getStatus(), code: failure.code }).toEqual({
        status: 503,
        code: 'INVENTORY_UNAVAILABLE',
      });
    });

    // El order_id de una liberación ya lo validó Sales, así que un rechazo de
    // Inventory significa que ambas bases ya no coinciden sobre esa orden: es
    // una falla interna, no un error del llamador (y cancelar no admite 422).
    it.each([
      [GrpcStatus.NOT_FOUND, 'reservation not found'],
      [GrpcStatus.INVALID_ARGUMENT, 'malformed order_id'],
      [GrpcStatus.FAILED_PRECONDITION, 'reservation already released'],
    ] as Array<[GrpcStatus, string]>)('traduce %s de ReleaseStock a 500 INTERNAL_ERROR', async (code, detail) => {
      client.reply = { error: grpcError(code, detail) };

      const failure = await captureFailure(gateway.release(ORDER_ID, TRACE_ID));

      expect({ status: failure.getStatus(), code: failure.code }).toEqual({ status: 500, code: 'INTERNAL_ERROR' });
      expect(failure.message).toBe('An unexpected internal error occurred');
      expect(client.calls).toHaveLength(1);
    });
  });

  describe('getPart', () => {
    it('consulta por part_id y devuelve el snapshot tipado de la pieza', async () => {
      client.reply = { error: null, response: { part: PROTO_BUJIA } };

      const part = await gateway.getPart(BUJIA.id, TRACE_ID);

      expect(part).toEqual({ partId: BUJIA.id, sku: BUJIA.sku, name: BUJIA.name, stockAvailable: 198 });
      expect(client.calls).toHaveLength(1);
      expect(client.calls[0]?.method).toBe('GetPart');
      expect(client.calls[0]?.request).toEqual({ part_id: BUJIA.id });
      expect(client.calls[0]?.metadata.get('x-trace-id')).toEqual([TRACE_ID]);
      const deadline = client.calls[0]?.options?.deadline;
      expect(typeof deadline).toBe('number');
      expect(deadline as number).toBeLessThanOrEqual(Date.now() + DEADLINE_MS);
    });

    it('registra el partId en lugar del orderId', async () => {
      client.reply = { error: null, response: { part: PROTO_BUJIA } };

      await gateway.getPart(BUJIA.id, TRACE_ID);

      const fields = logs[0]?.fields as Record<string, unknown>;
      expect(Object.keys(fields).sort()).toEqual(['durationMs', 'method', 'partId', 'status', 'traceId']);
      expect(fields).toMatchObject({ method: 'GetPart', status: 'OK', partId: BUJIA.id, traceId: TRACE_ID });
    });

    it('traduce NOT_FOUND a 422 PART_NOT_FOUND', async () => {
      client.reply = { error: grpcError(GrpcStatus.NOT_FOUND, 'part not found') };

      const failure = await captureFailure(gateway.getPart(BUJIA.id, TRACE_ID));

      expect({ status: failure.getStatus(), code: failure.code }).toEqual({ status: 422, code: 'PART_NOT_FOUND' });
      // Una sola RPC: la lectura tampoco reintenta (ADR-004).
      expect(client.calls).toHaveLength(1);
    });

    // FAILED_PRECONDITION es stock insuficiente: no pertenece a una lectura.
    it('traduce FAILED_PRECONDITION a 500 INTERNAL_ERROR', async () => {
      client.reply = { error: grpcError(GrpcStatus.FAILED_PRECONDITION, 'insufficient stock') };

      const failure = await captureFailure(gateway.getPart(BUJIA.id, TRACE_ID));

      expect({ status: failure.getStatus(), code: failure.code }).toEqual({ status: 500, code: 'INTERNAL_ERROR' });
    });
  });

  describe('listParts', () => {
    it('devuelve el inventario completo como snapshots en el orden del contrato', async () => {
      client.reply = { error: null, response: { parts: [PROTO_BUJIA, PROTO_FILTRO] } };

      const parts = await gateway.listParts(TRACE_ID);

      expect(parts).toEqual([
        { partId: BUJIA.id, sku: BUJIA.sku, name: BUJIA.name, stockAvailable: 198 },
        { partId: FILTRO.id, sku: FILTRO.sku, name: FILTRO.name, stockAvailable: 7 },
      ]);
      expect(client.calls).toHaveLength(1);
      expect(client.calls[0]?.method).toBe('ListParts');
      expect(client.calls[0]?.request).toEqual({});
      expect(client.calls[0]?.metadata.get('x-trace-id')).toEqual([TRACE_ID]);
    });

    it('traduce UNAVAILABLE a 503 INVENTORY_UNAVAILABLE', async () => {
      client.reply = { error: grpcError(GrpcStatus.UNAVAILABLE, 'No connection established') };

      const failure = await captureFailure(gateway.listParts(TRACE_ID));

      expect({ status: failure.getStatus(), code: failure.code }).toEqual({
        status: 503,
        code: 'INVENTORY_UNAVAILABLE',
      });
      expect(client.calls[0]?.method).toBe('ListParts');
    });
  });

  describe('onModuleDestroy', () => {
    it('cierra el cliente gRPC', () => {
      gateway.onModuleDestroy();

      expect(client.closed).toBe(true);
    });
  });
});
