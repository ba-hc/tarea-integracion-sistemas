import { describe, expect, it } from 'vitest';
import { toProtoTimestamp } from '../../src/grpc/timestamp.js';

describe('toProtoTimestamp', () => {
  it('separa segundos y nanosegundos', () => {
    expect(toProtoTimestamp(new Date('2026-09-24T12:00:00.123Z'))).toEqual({
      seconds: 1790251200,
      nanos: 123_000_000,
    });
  });

  it('usa nanos = 0 en un segundo exacto', () => {
    expect(toProtoTimestamp(new Date(0))).toEqual({ seconds: 0, nanos: 0 });
  });

  it('mantiene nanos no negativo antes de 1970', () => {
    // -0.5 s = segundo -1 + 500 ms
    expect(toProtoTimestamp(new Date(-500))).toEqual({ seconds: -1, nanos: 500_000_000 });
  });

  it('rechaza una fecha inválida', () => {
    expect(() => toProtoTimestamp(new Date('invalid'))).toThrow(TypeError);
  });
});
