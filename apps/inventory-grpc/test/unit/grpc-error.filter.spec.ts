import { GrpcAlreadyExistsException, GrpcStatus } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it } from 'vitest';
import {
  InsufficientStockError,
  InvalidArgumentError,
  OrderIdConflictError,
  PartNotFoundError,
  PartsNotFoundError,
  ReservationAlreadyReleasedError,
  ReservationNotFoundError,
} from '../../src/common/inventory-errors.js';
import { GrpcErrorFilter, toGrpcError } from '../../src/grpc/grpc-error.filter.js';

describe('toGrpcError', () => {
  it.each([
    ['InvalidArgumentError', new InvalidArgumentError('part_id must be a UUID'), GrpcStatus.INVALID_ARGUMENT],
    ['PartNotFoundError', new PartNotFoundError('p1'), GrpcStatus.NOT_FOUND],
    ['PartsNotFoundError', new PartsNotFoundError(['p1', 'p2']), GrpcStatus.NOT_FOUND],
    ['InsufficientStockError', new InsufficientStockError([{ partId: 'p1', requested: 3, available: 1 }]), GrpcStatus.FAILED_PRECONDITION],
    ['OrderIdConflictError', new OrderIdConflictError('o1'), GrpcStatus.ALREADY_EXISTS],
    ['ReservationNotFoundError (provisorio)', new ReservationNotFoundError('o1'), GrpcStatus.NOT_FOUND],
    ['ReservationAlreadyReleasedError (provisorio)', new ReservationAlreadyReleasedError('o1'), GrpcStatus.FAILED_PRECONDITION],
  ])('traduce %s según ERROR-MAPPING.md', (_label, error, code) => {
    expect(toGrpcError(error)).toEqual({ code, message: error.message });
  });

  it('respeta una GrpcException explícita', () => {
    expect(toGrpcError(new GrpcAlreadyExistsException('dup'))).toEqual({ code: GrpcStatus.ALREADY_EXISTS, message: 'dup' });
  });

  it.each([
    ['un error de base de datos', new Error('invalid input syntax for type uuid: "x" at parts.id (SELECT * FROM parts)')],
    ['un error con credenciales', new Error('connect to postgresql://inventory:secret@db:5432/inventory failed')],
    ['un valor que no es Error', 'boom'],
    ['undefined', undefined],
  ])('ante %s responde INTERNAL genérico sin filtrar el detalle', (_label, error) => {
    const result = toGrpcError(error);

    expect(result).toEqual({ code: GrpcStatus.INTERNAL, message: 'Internal error' });
    expect(JSON.stringify(result)).not.toMatch(/SELECT|secret|postgresql|uuid/);
  });
});

describe('GrpcErrorFilter', () => {
  it('emite el error traducido como Observable para el transporte gRPC de Nest', async () => {
    await expect(firstValueFrom(new GrpcErrorFilter().catch(new PartNotFoundError('x')))).rejects.toEqual({
      code: GrpcStatus.NOT_FOUND,
      message: 'part x not found',
    });
  });
});
