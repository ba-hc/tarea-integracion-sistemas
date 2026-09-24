// RS-401 - Helpers compartidos de la suite de sistema.
//
// Todo se habla por HTTP contra el contrato publico de Sales. La suite no
// conoce tablas, ORMs ni detalles internos de Sales o Inventory: si algo no se
// puede observar desde /v1, no se afirma aqui.

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

interface RequestOptions {
  apiKey?: string;
  body?: unknown;
  idempotencyKey?: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno ${name}. Ver tests/system/README.md`);
  }
  return value;
}

const baseUrl = process.env.SALES_BASE_URL ?? 'http://localhost:3000';

// Lazy: una prueba de autenticacion no deberia fallar por no tener sembrada
// la pieza del escenario de stock.
export const operatorKey = () => required('API_KEY_OPERATOR');
export const readerKey = () => required('API_KEY_READER');
export const partWithStock = () => required('PART_WITH_STOCK');

// Stock exacto con el que la pieza anterior esta sembrada. El escenario de
// stock lo consume entero y lo repone al terminar, asi que la suite se puede
// repetir contra el mismo stack sin resembrar.
export const partStock = Number(process.env.PART_STOCK ?? '5');

// UUID bien formado que no existe en Inventory. No necesita seed.
export const partUnknown = process.env.PART_UNKNOWN ?? '00000000-0000-4000-8000-0000000000ff';

let counter = 0;
const nextId = () => `${Date.now()}-${counter++}`;

export const uniqueEmail = () => `e2e-${nextId()}@repuestossur.test`;

// Cumple ^[A-Za-z0-9._:-]+$ con 8..128 caracteres, segun openapi.yaml.
export const newIdempotencyKey = () => `e2e-${nextId()}`;

export async function request<T = any>(
  method: string,
  path: string,
  options: RequestOptions = {}
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {};
  if (options.apiKey !== undefined) headers['X-API-Key'] = options.apiKey;
  if (options.idempotencyKey !== undefined) headers['Idempotency-Key'] = options.idempotencyKey;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  let body: any;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      // Un cuerpo no-JSON ya es una violacion del contrato; se conserva crudo
      // para que el mensaje de fallo muestre que llego de verdad.
      body = text;
    }
  }

  return { status: response.status, body, headers: response.headers };
}

function describeBody(body: unknown): string {
  return typeof body === 'string' ? body : JSON.stringify(body);
}

/** Falla con el codigo recibido y el cuerpo completo, no con un `true !== false`. */
export function expectStatus(response: ApiResponse, expected: number, context: string): void {
  if (response.status !== expected) {
    throw new Error(
      `${context}: se esperaba HTTP ${expected} y llego ${response.status}. Cuerpo: ${describeBody(response.body)}`
    );
  }
}

/** Verifica el envelope de error congelado: code, message y traceId. */
export function expectError(
  response: ApiResponse,
  expectedStatus: number,
  expectedCode: string,
  context: string
): void {
  expectStatus(response, expectedStatus, context);

  if (response.body?.code !== expectedCode) {
    throw new Error(
      `${context}: se esperaba el codigo ${expectedCode} y llego ${response.body?.code}. Cuerpo: ${describeBody(response.body)}`
    );
  }
  if (typeof response.body?.message !== 'string' || response.body.message.length === 0) {
    throw new Error(`${context}: el error no trae 'message'. Cuerpo: ${describeBody(response.body)}`);
  }
  if (!response.body?.traceId) {
    throw new Error(`${context}: el error no trae 'traceId'. Cuerpo: ${describeBody(response.body)}`);
  }
}

export async function createCustomer(name = 'Cliente E2E'): Promise<any> {
  const response = await request('POST', '/v1/customers', {
    apiKey: operatorKey(),
    body: { name, email: uniqueEmail() },
  });
  expectStatus(response, 201, 'crear el cliente de apoyo');
  return response.body;
}

export function createOrder(
  customerId: string,
  partId: string,
  quantity = 1,
  idempotencyKey = newIdempotencyKey()
): Promise<ApiResponse> {
  return request('POST', '/v1/orders', {
    apiKey: operatorKey(),
    idempotencyKey,
    body: { customerId, items: [{ partId, quantity }] },
  });
}

export function cancelOrder(orderId: string): Promise<ApiResponse> {
  return request('POST', `/v1/orders/${orderId}/cancel`, { apiKey: operatorKey() });
}
