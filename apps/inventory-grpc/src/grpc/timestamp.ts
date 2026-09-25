import type { ProtoTimestamp } from './inventory.proto-types.js';

/**
 * Date -> google.protobuf.Timestamp. `nanos` siempre queda en [0, 1e9), también
 * para fechas anteriores a 1970, como exige la definición del tipo.
 */
export function toProtoTimestamp(date: Date): ProtoTimestamp {
  const millis = date.getTime();
  if (Number.isNaN(millis)) {
    throw new TypeError('cannot convert an invalid Date to a Timestamp');
  }
  const seconds = Math.floor(millis / 1000);
  return { seconds, nanos: (millis - seconds * 1000) * 1_000_000 };
}
