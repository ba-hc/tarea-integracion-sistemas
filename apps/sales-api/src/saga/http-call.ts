/**
 * Una llamada HTTP JSON interna con plazo máximo y sin reintentos.
 *
 * Clasifica el resultado en lo único que le importa a la Saga: ¿sabemos si el
 * servidor recibió y procesó el comando?
 *
 * - `response`: hubo respuesta HTTP completa (cualquier status).
 * - `not_sent`: la conexión nunca se estableció (DNS inexistente o conexión
 *   rechazada). El servidor no pudo ejecutar nada: es un rechazo seguro.
 * - `timeout`: se agotó el plazo. El comando pudo haberse aplicado.
 * - `failed`: cualquier otra falla de red o respuesta ilegible. También en duda.
 */
export type HttpCallResult =
  | { kind: 'response'; status: number; body: unknown }
  | { kind: 'not_sent' }
  | { kind: 'timeout' }
  | { kind: 'failed' };

export interface HttpCallRequest {
  baseUrl: string;
  method: 'GET' | 'PUT' | 'POST';
  path: string;
  body?: unknown;
  timeoutMs: number;
  traceId: string;
}

/** Códigos de Node/undici que garantizan que no se envió ningún byte de la solicitud. */
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

/** Cuerpo máximo aceptado: las respuestas internas son objetos pequeños. */
const MAX_RESPONSE_BYTES = 64 * 1024;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorCode(error: unknown): string | undefined {
  // fetch envuelve el error de socket en `cause`; a veces dentro de un AggregateError.
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const { code, cause, errors } = current as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof code === 'string') return code;
    if (Array.isArray(errors) && errors.length > 0) {
      current = errors[0];
      continue;
    }
    current = cause;
  }
  return undefined;
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

export async function httpCall(request: HttpCallRequest): Promise<HttpCallResult> {
  const headers: Record<string, string> = { accept: 'application/json' };
  // Sólo se propaga un UUID: Despacho y Pagos descartan otros formatos.
  if (UUID_PATTERN.test(request.traceId)) headers['x-trace-id'] = request.traceId;
  if (request.body !== undefined) headers['content-type'] = 'application/json';

  // El mismo plazo cubre conexión, cabeceras y lectura completa del cuerpo.
  const signal = AbortSignal.timeout(request.timeoutMs);
  try {
    const init: RequestInit = { method: request.method, headers, redirect: 'manual', signal };
    if (request.body !== undefined) init.body = JSON.stringify(request.body);
    const response = await fetch(`${request.baseUrl}${request.path}`, init);
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) return { kind: 'failed' };
    let body: unknown;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        // Un 2xx ilegible no prueba nada; un error ilegible sigue siendo un error.
        if (response.status < 300) return { kind: 'failed' };
        body = undefined;
      }
    }
    return { kind: 'response', status: response.status, body };
  } catch (error) {
    if (isTimeout(error) || signal.aborted) return { kind: 'timeout' };
    const code = errorCode(error);
    if (code !== undefined && NOT_SENT_CODES.has(code)) return { kind: 'not_sent' };
    return { kind: 'failed' };
  }
}

/** Lee `body.code` de un envelope de error, si existe. */
export function errorCodeOf(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const code = (body as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** Lee `body.status` y verifica que `body.orderId` coincida con la venta. */
export function statusOf(body: unknown, orderId: string): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const record = body as { orderId?: unknown; status?: unknown };
  if (typeof record.orderId !== 'string' || record.orderId.toLowerCase() !== orderId.toLowerCase()) return undefined;
  return typeof record.status === 'string' ? record.status : undefined;
}
