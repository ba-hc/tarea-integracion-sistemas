import { describe, expect, it, vi } from 'vitest';
import { createLogger, redactSecrets } from '../../src/logging/logger.js';

describe('redactSecrets', () => {
  it.each([
    ['postgresql://inventory:s3cret@db:5432/inventory', 'postgresql://***@db:5432/inventory'],
    ['error: connect postgres://u:p@10.0.0.1/x failed', 'error: connect postgres://***@10.0.0.1/x failed'],
    ['sin credenciales postgresql://db:5432/inventory', 'sin credenciales postgresql://db:5432/inventory'],
    ['texto normal', 'texto normal'],
  ])('%s', (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it('borra todas las apariciones', () => {
    expect(redactSecrets('a://x:y@h b://z:w@h')).toBe('a://***@h b://***@h');
  });
});

describe('createLogger', () => {
  it('en formato json escribe una línea JSON con los campos estructurados en la raíz', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      createLogger({ logFormat: 'json', logLevel: 'log' }).log('grpc call completed', { method: 'GetPart', code: 'OK' }, 'GrpcCall');

      const line = String(write.mock.calls[0]?.[0]);
      expect(line.endsWith('\n')).toBe(true);
      expect(JSON.parse(line)).toMatchObject({
        level: 'log',
        context: 'GrpcCall',
        message: 'grpc call completed',
        method: 'GetPart',
        code: 'OK',
      });
    } finally {
      write.mockRestore();
    }
  });

  it('respeta el nivel mínimo', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const logger = createLogger({ logFormat: 'json', logLevel: 'warn' });
      logger.log('omitido');
      logger.debug?.('omitido');
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });
});
