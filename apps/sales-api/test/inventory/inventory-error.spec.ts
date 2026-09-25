import { Metadata, status as GrpcStatus, type ServiceError } from '@grpc/grpc-js';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/common/api-error.js';
import { grpcStatusName, toInventoryApiError, type InventoryOperation } from '../../src/inventory/inventory-error.js';

// Mensaje realista de Inventory: si apareciera en el envelope público, sería
// una fuga de la implementación (SQL/Prisma) hacia el cliente.
const RAW_DETAIL = 'SQLSTATE 23505: duplicate key value violates unique constraint "stock_operations_order_id_key"';

/** Falla tal como la entrega grpc-js en el callback de una RPC unaria. */
function grpcError(code: GrpcStatus, message: string, details = ''): ServiceError {
  return Object.assign(new Error(message), { code, details, metadata: new Metadata() });
}

/** [llamada, estado gRPC, HTTP, código público, mensaje público] */
type Case = [operation: InventoryOperation, code: GrpcStatus, status: number, errorCode: string, message: string];

// Tabla "Traducción de Sales para llamadas que mutan órdenes" de ERROR-MAPPING.md
// más los estados que esa tabla no puede desambiguar por sí sola.
const CASES: Case[] = [
  // Reservar: el payload lo envió el llamador, así que describe su error.
  ['reserve', GrpcStatus.INVALID_ARGUMENT, 400, 'VALIDATION_ERROR', 'Request validation failed'],
  ['reserve', GrpcStatus.NOT_FOUND, 422, 'PART_NOT_FOUND', 'One or more requested parts do not exist'],
  [
    'reserve',
    GrpcStatus.FAILED_PRECONDITION,
    409,
    'INSUFFICIENT_STOCK',
    'One or more parts do not have enough stock',
  ],
  // Liberar: el order_id ya lo validó Sales, así que un rechazo significa que
  // Sales e Inventory no coinciden sobre esa orden. El contrato de cancelación
  // tampoco admite 422 ni 409.
  ['release', GrpcStatus.INVALID_ARGUMENT, 500, 'INTERNAL_ERROR', 'An unexpected internal error occurred'],
  ['release', GrpcStatus.NOT_FOUND, 500, 'INTERNAL_ERROR', 'An unexpected internal error occurred'],
  ['release', GrpcStatus.FAILED_PRECONDITION, 500, 'INTERNAL_ERROR', 'An unexpected internal error occurred'],
  // Leer: el partId vuelve a venir del llamador; sólo el stock no aplica.
  ['read', GrpcStatus.INVALID_ARGUMENT, 400, 'VALIDATION_ERROR', 'Request validation failed'],
  ['read', GrpcStatus.NOT_FOUND, 422, 'PART_NOT_FOUND', 'One or more requested parts do not exist'],
  ['read', GrpcStatus.FAILED_PRECONDITION, 500, 'INTERNAL_ERROR', 'An unexpected internal error occurred'],
];

const OPERATIONS: InventoryOperation[] = ['reserve', 'release', 'read'];

// El orden de los marcadores sigue el de la tupla: llamada, estado, HTTP, código público, mensaje.
describe('toInventoryApiError', () => {
  it.each(CASES)('%s: traduce %s a %i %s: %s', (operation, code, status, errorCode, message) => {
    const error = toInventoryApiError(grpcError(code, RAW_DETAIL, RAW_DETAIL), operation);

    expect(error).toBeInstanceOf(ApiError);
    expect({ status: error.getStatus(), code: error.code, message: error.message }).toEqual({
      status,
      code: errorCode,
      message,
    });
  });

  // Una dependencia caída o lenta nunca deja de ser 503/504, en cualquier llamada.
  it.each(OPERATIONS)('%s conserva 503 y 504', (operation) => {
    const unavailable = toInventoryApiError(grpcError(GrpcStatus.UNAVAILABLE, RAW_DETAIL), operation);
    const timeout = toInventoryApiError(grpcError(GrpcStatus.DEADLINE_EXCEEDED, RAW_DETAIL), operation);

    expect({ status: unavailable.getStatus(), code: unavailable.code }).toEqual({
      status: 503,
      code: 'INVENTORY_UNAVAILABLE',
    });
    expect({ status: timeout.getStatus(), code: timeout.code }).toEqual({ status: 504, code: 'INVENTORY_TIMEOUT' });
  });

  // Ni siquiera un OK inesperado se propaga: sin traducción no hay éxito válido,
  // así que todo lo no listado es una falla interna de Sales o de su dependencia.
  it.each(OPERATIONS)('%s colapsa los estados no listados a 500 INTERNAL_ERROR', (operation) => {
    for (const code of [GrpcStatus.OK, GrpcStatus.ALREADY_EXISTS, GrpcStatus.INTERNAL, GrpcStatus.UNKNOWN, GrpcStatus.DATA_LOSS]) {
      const error = toInventoryApiError(grpcError(code, RAW_DETAIL), operation);

      expect({ status: error.getStatus(), code: error.code }).toEqual({ status: 500, code: 'INTERNAL_ERROR' });
    }
  });

  it.each(OPERATIONS)('%s trata una falla que no viene de gRPC como 500 INTERNAL_ERROR', (operation) => {
    for (const failure of [new TypeError('response.items is not iterable'), { code: 'ECONNREFUSED' }, null, 'boom']) {
      const error = toInventoryApiError(failure, operation);

      expect(error).toBeInstanceOf(ApiError);
      expect({ status: error.getStatus(), code: error.code }).toEqual({ status: 500, code: 'INTERNAL_ERROR' });
    }
  });

  it('no propaga el mensaje del servidor en el envelope público', () => {
    const error = toInventoryApiError(grpcError(GrpcStatus.NOT_FOUND, RAW_DETAIL, RAW_DETAIL), 'reserve');
    const envelope = JSON.stringify({ code: error.code, message: error.message, details: error.details });

    expect(error.message).toBe('One or more requested parts do not exist');
    expect(envelope).not.toContain('SQLSTATE');
    expect(envelope).not.toContain('stock_operations');
  });
});

describe('grpcStatusName', () => {
  const NAMES: Array<[GrpcStatus, string]> = [
    [GrpcStatus.OK, 'OK'],
    [GrpcStatus.INVALID_ARGUMENT, 'INVALID_ARGUMENT'],
    [GrpcStatus.NOT_FOUND, 'NOT_FOUND'],
    [GrpcStatus.ALREADY_EXISTS, 'ALREADY_EXISTS'],
    [GrpcStatus.FAILED_PRECONDITION, 'FAILED_PRECONDITION'],
    [GrpcStatus.UNAVAILABLE, 'UNAVAILABLE'],
    [GrpcStatus.DEADLINE_EXCEEDED, 'DEADLINE_EXCEEDED'],
    [GrpcStatus.RESOURCE_EXHAUSTED, 'RESOURCE_EXHAUSTED'],
  ];

  it.each(NAMES)('nombra %s como %s para los logs', (code, name) => {
    expect(grpcStatusName(grpcError(code, 'x'))).toBe(name);
  });

  it('nombra UNKNOWN un error que no viene de gRPC', () => {
    expect(grpcStatusName(new Error('socket hang up'))).toBe('UNKNOWN');
    expect(grpcStatusName({ code: 'ECONNREFUSED' })).toBe('UNKNOWN');
  });
});
