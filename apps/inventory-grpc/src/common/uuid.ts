// Forma canónica 8-4-4-4-12 en hexadecimal. No se exige una versión concreta
// de UUID: basta con que PostgreSQL pueda interpretarlo como `uuid`.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}
