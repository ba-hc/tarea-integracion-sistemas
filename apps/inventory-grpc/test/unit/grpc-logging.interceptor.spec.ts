import { Logger, type ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InsufficientStockError } from '../../src/common/inventory-errors.js';
import { GrpcLoggingInterceptor } from '../../src/logging/grpc-logging.interceptor.js';

function contextFor(handlerName: string, data: object, metadata: Record<string, string> = {}): ExecutionContext {
  const handler = { [handlerName]: () => undefined }[handlerName]!;
  return {
    getHandler: () => handler,
    switchToRpc: () => ({
      getData: () => data,
      getContext: () => ({ get: (key: string) => (key in metadata ? [metadata[key]] : []) }),
    }),
  } as unknown as ExecutionContext;
}

describe('GrpcLoggingInterceptor', () => {
  const interceptor = new GrpcLoggingInterceptor();
  let log: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registra una llamada exitosa con método, código, duración, traceId e ids', async () => {
    const context = contextFor('getPart', { part_id: 'p-1' }, { 'x-trace-id': 'trace-123' });

    await lastValueFrom(interceptor.intercept(context, { handle: () => of({ part: {} }) }));

    expect(log).toHaveBeenCalledWith('grpc call completed', {
      method: 'GetPart',
      code: 'OK',
      durationMs: expect.any(Number),
      traceId: 'trace-123',
      partId: 'p-1',
    });
  });

  it('genera un traceId si no viene o si es inválido', async () => {
    const cases: Array<Record<string, string>> = [{}, { 'x-trace-id': 'con espacios\ny salto' }, { 'x-trace-id': 'x'.repeat(200) }];
    for (const metadata of cases) {
      log.mockClear();
      await lastValueFrom(interceptor.intercept(contextFor('listParts', {}, metadata), { handle: () => of({}) }));

      const fields = log.mock.calls[0]?.[1] as { traceId: string };
      expect(fields.traceId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('registra un rechazo esperado con su código gRPC, sin stack', async () => {
    const context = contextFor('reserveStock', { order_id: 'o-1', items: [{}, {}] });
    const failure = new InsufficientStockError([{ partId: 'p', requested: 2, available: 1 }]);

    await expect(lastValueFrom(interceptor.intercept(context, { handle: () => throwError(() => failure) }))).rejects.toBe(failure);

    expect(log).toHaveBeenCalledWith('grpc call rejected', expect.objectContaining({
      method: 'ReserveStock',
      code: 'FAILED_PRECONDITION',
      orderId: 'o-1',
      itemCount: 2,
    }));
    expect(error).not.toHaveBeenCalled();
  });

  it('registra un error inesperado como INTERNAL con stack y sin credenciales', async () => {
    const context = contextFor('releaseStock', { order_id: 'o-1' }, { 'x-trace-id': 'trace-9' });
    const failure = new Error('connect postgresql://inventory:s3cret@db:5432/inventory refused');

    await expect(lastValueFrom(interceptor.intercept(context, { handle: () => throwError(() => failure) }))).rejects.toBe(failure);

    expect(error).toHaveBeenCalledTimes(1);
    const [message, fields] = error.mock.calls[0] as [string, Record<string, string>];
    expect(message).toBe('grpc call failed unexpectedly');
    expect(fields).toMatchObject({ method: 'ReleaseStock', code: 'INTERNAL', traceId: 'trace-9', orderId: 'o-1' });
    expect(fields.error).toContain('postgresql://***@db:5432/inventory');
    expect(fields.error).not.toContain('s3cret');
  });

  it('no registra el payload completo, sólo ids acotados', async () => {
    const context = contextFor('reserveStock', { order_id: 'o'.repeat(500), items: [{ part_id: 'secreto', quantity: 1 }] });

    await lastValueFrom(interceptor.intercept(context, { handle: () => of({}) }));

    const fields = log.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(String(fields.orderId)).toHaveLength(64);
    expect(JSON.stringify(fields)).not.toContain('secreto');
  });
});
