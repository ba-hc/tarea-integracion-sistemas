import { randomUUID } from 'node:crypto';

/**
 * Pasarela de pagos simulada (T2-201).
 *
 * Es un tercero externo a RepuestosSur: guarda sus cobros en memoria e
 * identifica cada cobro y reembolso por la clave de idempotencia que envía
 * Pagos. Repetir una clave devuelve el resultado original sin un segundo
 * efecto.
 *
 * Modos (se cambian en caliente con PUT /admin/config):
 * - normal:  aplica y responde tras `latencyMs`.
 * - slow:    aplica al recibir y responde tras `slowDelayMs`. Si el cliente
 *            abandona antes, el efecto ya ocurrió: es el caso «resultado incierto».
 * - down:    responde 503 GATEWAY_UNAVAILABLE sin aplicar nada.
 * - decline: rechaza los cobros nuevos (DECLINED).
 */
export const MODES = Object.freeze(['normal', 'slow', 'down', 'decline']);

const MAX_BODY_BYTES = 16 * 1024;
const MAX_DELAY_MS = 120_000;
const KEY_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isDelay(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_DELAY_MS;
}

export function validateConfig(config) {
  if (!MODES.includes(config.mode)) throw new Error(`mode must be one of ${MODES.join(', ')}`);
  if (!isDelay(config.latencyMs)) throw new Error(`latencyMs must be an integer between 0 and ${MAX_DELAY_MS}`);
  if (!isDelay(config.slowDelayMs)) throw new Error(`slowDelayMs must be an integer between 0 and ${MAX_DELAY_MS}`);
  return config;
}

export function configFromEnv(env = process.env) {
  const integer = (name, fallback) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer`);
    return Number(raw);
  };
  return validateConfig({
    mode: env.GATEWAY_SIM_MODE || 'normal',
    latencyMs: integer('GATEWAY_SIM_LATENCY_MS', 20),
    slowDelayMs: integer('GATEWAY_SIM_SLOW_DELAY_MS', 3_000),
  });
}

export function createSimulator(initialConfig) {
  let config = validateConfig({ ...initialConfig });
  const charges = new Map();
  const refunds = new Map();
  const stats = {
    apiRequests: 0,
    chargesApproved: 0,
    chargesDeclined: 0,
    chargeReplays: 0,
    refunds: 0,
    voids: 0,
    refundReplays: 0,
    rejectedWhileDown: 0,
  };
  const timers = new Set();

  function wait(ms) {
    if (ms === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        resolve();
      }, ms);
      timers.add(timer);
    });
  }

  function responseDelay() {
    return config.mode === 'slow' ? config.slowDelayMs : config.latencyMs;
  }

  function rejectIfDown() {
    if (config.mode !== 'down') return;
    stats.rejectedWhileDown += 1;
    throw new HttpError(503, 'GATEWAY_UNAVAILABLE', 'Payment gateway is unavailable');
  }

  function charge(body) {
    if (!isRecord(body) || !KEY_PATTERN.test(body.idempotencyKey ?? '')
      || !Number.isSafeInteger(body.amountMinor) || body.amountMinor < 1
      || typeof body.currency !== 'string' || !CURRENCY_PATTERN.test(body.currency)) {
      throw new HttpError(400, 'INVALID_REQUEST', 'idempotencyKey, amountMinor and currency are required');
    }
    rejectIfDown();
    const existing = charges.get(body.idempotencyKey);
    if (existing) {
      if (existing.status !== 'VOIDED'
        && (existing.amountMinor !== body.amountMinor || existing.currency !== body.currency)) {
        throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key reused with a different charge');
      }
      stats.chargeReplays += 1;
      return existing;
    }
    const status = config.mode === 'decline' ? 'DECLINED' : 'APPROVED';
    const created = {
      chargeId: randomUUID(),
      idempotencyKey: body.idempotencyKey,
      amountMinor: body.amountMinor,
      currency: body.currency,
      status,
    };
    charges.set(created.idempotencyKey, created);
    if (status === 'APPROVED') stats.chargesApproved += 1;
    else stats.chargesDeclined += 1;
    return created;
  }

  function getCharge(key) {
    rejectIfDown();
    const existing = charges.get(key);
    if (!existing) throw new HttpError(404, 'CHARGE_NOT_FOUND', 'Charge not found');
    return existing;
  }

  function refund(body) {
    if (!isRecord(body) || !KEY_PATTERN.test(body.idempotencyKey ?? '')
      || !KEY_PATTERN.test(body.chargeIdempotencyKey ?? '')) {
      throw new HttpError(400, 'INVALID_REQUEST', 'idempotencyKey and chargeIdempotencyKey are required');
    }
    rejectIfDown();
    const previous = refunds.get(body.idempotencyKey);
    if (previous) {
      if (previous.chargeIdempotencyKey !== body.chargeIdempotencyKey) {
        throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key reused with a different charge');
      }
      stats.refundReplays += 1;
      return previous;
    }
    let target = charges.get(body.chargeIdempotencyKey);
    if (target?.status === 'DECLINED') {
      throw new HttpError(409, 'CHARGE_NOT_REFUNDABLE', 'A declined charge cannot be refunded');
    }
    if (!target) {
      // Anula una clave de cobro que nunca llegó: un cobro posterior con esa clave no tendrá efecto.
      target = {
        chargeId: null,
        idempotencyKey: body.chargeIdempotencyKey,
        amountMinor: null,
        currency: null,
        status: 'VOIDED',
      };
      charges.set(target.idempotencyKey, target);
      stats.voids += 1;
    } else if (target.status === 'APPROVED') {
      target.status = 'REFUNDED';
      stats.refunds += 1;
    }
    const created = {
      refundId: randomUUID(),
      idempotencyKey: body.idempotencyKey,
      chargeIdempotencyKey: body.chargeIdempotencyKey,
      status: target.status,
    };
    refunds.set(created.idempotencyKey, created);
    return created;
  }

  function updateConfig(body) {
    if (!isRecord(body)) throw new HttpError(400, 'INVALID_REQUEST', 'Body must be an object');
    const allowed = new Set(['mode', 'latencyMs', 'slowDelayMs']);
    if (Object.keys(body).some((key) => !allowed.has(key))) {
      throw new HttpError(400, 'INVALID_REQUEST', 'Only mode, latencyMs and slowDelayMs can be set');
    }
    try {
      config = validateConfig({ ...config, ...body });
    } catch (error) {
      throw new HttpError(400, 'INVALID_REQUEST', error.message);
    }
    return { ...config };
  }

  async function route(method, path, body) {
    if (method === 'GET' && path === '/health') return { status: 200, body: { status: 'ok' }, immediate: true };
    if (method === 'GET' && path === '/admin/config') {
      return { status: 200, body: { ...config, stats: { ...stats } }, immediate: true };
    }
    if (method === 'PUT' && path === '/admin/config') {
      return { status: 200, body: updateConfig(await body()), immediate: true };
    }
    if (method === 'POST' && path === '/v1/charges') return { status: 200, body: charge(await body()) };
    if (method === 'POST' && path === '/v1/refunds') return { status: 200, body: refund(await body()) };
    const chargePath = /^\/v1\/charges\/([^/]+)$/.exec(path);
    if (method === 'GET' && chargePath) return { status: 200, body: getCharge(decodeURIComponent(chargePath[1])) };
    throw new HttpError(404, 'NOT_FOUND', 'Route not found');
  }

  async function readBody(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Body too large');
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new HttpError(400, 'INVALID_REQUEST', 'Body must be JSON');
    }
  }

  async function handle(request, response) {
    const path = new URL(request.url ?? '/', 'http://simulator').pathname;
    if (path.startsWith('/v1/')) stats.apiRequests += 1;
    let result;
    try {
      result = await route(request.method ?? 'GET', path, () => readBody(request));
    } catch (error) {
      result = error instanceof HttpError
        ? { status: error.status, body: { code: error.code, message: error.message } }
        : { status: 500, body: { code: 'INTERNAL_ERROR', message: 'Unexpected simulator error' } };
    }
    if (!result.immediate) await wait(responseDelay());
    if (response.destroyed) return;
    response.writeHead(result.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result.body));
  }

  function close() {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  }

  return { handle, close, config: () => ({ ...config }), stats: () => ({ ...stats }) };
}
