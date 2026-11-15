import type { IncomingMessage } from 'node:http';

export function rawHeaderValues(request: IncomingMessage, name: string): string[] {
  const lower = name.toLowerCase();
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const headerName = request.rawHeaders[index];
    if (headerName?.toLowerCase() !== lower) continue;
    const value = request.rawHeaders[index + 1];
    if (value !== undefined) values.push(value);
  }
  return values;
}

export function hasRequestBody(request: IncomingMessage): boolean {
  if (rawHeaderValues(request, 'transfer-encoding').length > 0) return true;
  const contentLength = rawHeaderValues(request, 'content-length')[0];
  if (contentLength === undefined) return false;
  return contentLength !== '0';
}

export function isJsonMediaType(value: string | undefined): boolean {
  if (value === undefined) return false;
  return value.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}
