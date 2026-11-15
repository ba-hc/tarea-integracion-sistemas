const BEARER_PATTERN = /^Bearer +([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i;
const MAX_AUTHORIZATION_LENGTH = 8_192;

export function parseBearer(value: string | undefined): string | null {
  if (value === undefined || value.length > MAX_AUTHORIZATION_LENGTH) return null;
  const match = BEARER_PATTERN.exec(value);
  return match?.[1] ?? null;
}
