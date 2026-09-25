import { Logger } from '@nestjs/common';
import { GrpcAlreadyExistsException, GrpcStatus } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidArgumentError, PartNotFoundError } from '../../src/common/inventory-errors.js';
import { GrpcErrorFilter } from '../../src/grpc/grpc-error.filter.js';

describe('GrpcErrorFilter', () => {
  const filter = new GrpcErrorFilter();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('traduce InvalidArgumentError a INVALID_ARGUMENT', () => {
    expect(filter.toGrpcError(new InvalidArgumentError('part_id must be a UUID'))).toEqual({
      code: GrpcStatus.INVALID_ARGUMENT,
      message: 'part_id must be a UUID',
    });
  });

  it('traduce PartNotFoundError a NOT_FOUND', () => {
    const id = 'd6e1fd98-cb07-458f-aa12-6fe220b37604';
    expect(filter.toGrpcError(new PartNotFoundError(id))).toEqual({
      code: GrpcStatus.NOT_FOUND,
      message: `part ${id} not found`,
    });
  });

  it('respeta una GrpcException explícita', () => {
    expect(filter.toGrpcError(new GrpcAlreadyExistsException('dup'))).toEqual({
      code: GrpcStatus.ALREADY_EXISTS,
      message: 'dup',
    });
  });

  it('responde INTERNAL genérico ante un error inesperado, sin filtrar el detalle', () => {
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const dbError = new Error('invalid input syntax for type uuid: "x" at parts.id (SELECT ...)');

    const result = filter.toGrpcError(dbError);

    expect(result).toEqual({ code: GrpcStatus.INTERNAL, message: 'Internal error' });
    expect(JSON.stringify(result)).not.toContain('SELECT');
    // El detalle sí queda en el log del servicio.
    expect(log).toHaveBeenCalledWith(expect.any(String), dbError.stack);
  });

  it('catch() emite el error como Observable para el transporte gRPC de Nest', async () => {
    await expect(firstValueFrom(filter.catch(new PartNotFoundError('x')))).rejects.toMatchObject({
      code: GrpcStatus.NOT_FOUND,
    });
  });
});
