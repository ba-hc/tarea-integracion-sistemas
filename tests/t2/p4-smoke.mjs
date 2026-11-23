#!/usr/bin/env node
// P4 system smoke. Run from the repository root:
//   node tests/t2/p4-smoke.mjs
// Optional: GATEWAY_BASE_URL, GATEWAY_READER_TOKEN, GATEWAY_OPERATOR_TOKEN,
//           P4_SMOKE_EXPECT_STEPS=stock|stock,dispatch|stock,payment,dispatch|full,
//           P4_SMOKE_DISPATCH_FIXTURE=true.
// The smoke reads SAGA_STEPS from the real sales-api container before any
// mutation. It supports stock, stock,dispatch and the full three-step Saga with
// the real payments-api and the simulated gateway. Unsupported subsets are
// rejected honestly. Compose exec respects COMPOSE_PROJECT_NAME and
// COMPOSE_ENV_FILES. Tokens are never printed. The script cancels its test
// orders/dispatch in finally.

import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const PART_ID = 'e58e2904-9db7-4c8d-8f36-7107e863a268';
export const DEFAULT_GATEWAY_BASE_URL = 'http://127.0.0.1:8080';
export const SUPPORTED_SAGA_MODES = Object.freeze(['stock', 'stock,dispatch', 'stock,payment,dispatch']);
const COMPOSE = ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.p4.yml'];
const HTTP_TIMEOUT_MS = 5_000;
const CLI_TIMEOUT_MS = 20_000;
const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 60;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_RATE_LIMIT_REQUESTS = 1_000;
const MAX_RATE_LIMIT_ROUNDS = 2;
const MAX_RATE_LIMIT_TOTAL_REQUESTS = MAX_RATE_LIMIT_ROUNDS * (MAX_RATE_LIMIT_REQUESTS + 1);

let operatorToken;
let readerToken;
let createdOrderId;
let summaryOrderId;
let dispatchOrderId;

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function expectStatus(response, expected, step) {
  if (response.status !== expected) {
    throw new Error(`${step}: expected HTTP ${expected}, got ${response.status}`);
  }
}

export function codeOf(response) {
  return response.json !== null && typeof response.json === 'object'
    ? response.json.code
    : undefined;
}

export function expectCode(response, expected, step) {
  const code = codeOf(response);
  if (code !== expected) throw new Error(`${step}: expected code ${expected}, got ${code ?? 'none'}`);
}

export function assertUuid(value, step) {
  assert(
    typeof value === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
    `${step}: expected UUID`,
  );
}

export function parseSagaSteps(raw) {
  if (typeof raw !== 'string') throw new Error('SAGA_STEPS is missing in sales-api');
  const parts = raw.split(',').map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => part === '')) {
    throw new Error('SAGA_STEPS contains an empty step');
  }
  if (new Set(parts).size !== parts.length) {
    throw new Error('SAGA_STEPS contains duplicate steps');
  }
  return parts.join(',');
}

export function resolveSmokeMode({ actual, expected } = {}) {
  const actualSteps = parseSagaSteps(actual);
  if (!SUPPORTED_SAGA_MODES.includes(actualSteps)) {
    throw new Error(
      `SAGA_STEPS no soportado en esta fase: ${actualSteps}; `
      + 'se admiten stock, stock,dispatch o stock,payment,dispatch',
    );
  }

  if (expected !== undefined && expected !== null && String(expected).trim() !== '') {
    const rawExpected = String(expected).trim();
    const expectedSteps = rawExpected === 'full' ? 'stock,payment,dispatch' : parseSagaSteps(rawExpected);
    if (!SUPPORTED_SAGA_MODES.includes(expectedSteps)) {
      throw new Error(
        `P4_SMOKE_EXPECT_STEPS no soportado en esta fase: ${expectedSteps}; `
        + 'se admiten stock, stock,dispatch o stock,payment,dispatch',
      );
    }
    if (expectedSteps !== actualSteps) {
      throw new Error(
        `P4_SMOKE_EXPECT_STEPS=${expectedSteps} no coincide con SAGA_STEPS real=${actualSteps}`,
      );
    }
  }

  return actualSteps;
}

export function assertLoopbackBaseUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Error('GATEWAY_BASE_URL must be an absolute http URL');
  }
  if (url.protocol !== 'http:') throw new Error('GATEWAY_BASE_URL must use http for the local stack');
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new Error('GATEWAY_BASE_URL must point to 127.0.0.1 or localhost');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('GATEWAY_BASE_URL must not include credentials');
  }
  if (url.port === '') throw new Error('GATEWAY_BASE_URL must include an explicit port');
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('GATEWAY_BASE_URL must not include a path, query or fragment');
  }
  return url.origin;
}

export function composeEnvironment(env = process.env) {
  return { ...env };
}

export function runDocker(args, timeoutMs = CLI_TIMEOUT_MS, {
  spawn = spawnSync,
  env = composeEnvironment(),
} = {}) {
  const result = spawn('docker', [...COMPOSE, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    shell: false,
    maxBuffer: 1024 * 1024,
    env,
  });
  if (result.error !== undefined) {
    throw new Error(`docker command failed: ${result.error.name}`);
  }
  return result;
}

export function readContainerEnv(service, name, {
  run = runDocker,
  timeoutMs = 10_000,
  allowEmpty = false,
} = {}) {
  if (!/^[a-z0-9-]+$/.test(service)) throw new Error('invalid container service name');
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error('invalid container environment name');
  const result = run([
    'exec',
    '-T',
    service,
    'node',
    '--input-type=module',
    '-e',
    `process.stdout.write(process.env.${name} ?? '')`,
  ], timeoutMs);
  if (result.error !== undefined) {
    throw new Error(`cannot read ${name} from ${service}: ${result.error.name}`);
  }
  if (result.status !== 0) {
    throw new Error(`cannot read ${name} from ${service}: docker exec exit ${result.status ?? 'unknown'}`);
  }
  const value = (result.stdout ?? '').trim();
  if (!allowEmpty && value === '') throw new Error(`${name} is empty in ${service}`);
  return value;
}

export function tokenFromCli(role, subject, {
  run = runDocker,
  timeoutMs = CLI_TIMEOUT_MS,
  service = 'api-gateway',
} = {}) {
  if (role !== 'reader' && role !== 'operator') throw new Error(`invalid role: ${role}`);
  assert(typeof subject === 'string' && subject.length > 0, 'token subject is required');
  const result = run([
    'exec',
    '-T',
    service,
    'node',
    'dist/src/cli/token.js',
    '--sub',
    subject,
    '--role',
    role,
  ], timeoutMs);
  if (result.error !== undefined) {
    throw new Error(`token CLI failed for ${role}: ${result.error.name}`);
  }
  if (result.status !== 0) {
    throw new Error(`token CLI failed for ${role}; rebuild the P4 images with the overlay`);
  }
  const token = (result.stdout ?? '').trim();
  assert(token.split('.').length === 3, `token CLI for ${role} returned an invalid token`);
  return token;
}

export function createHttpClient(rawBaseUrl, {
  timeoutMs = HTTP_TIMEOUT_MS,
  fetchImpl = fetch,
} = {}) {
  const base = assertLoopbackBaseUrl(rawBaseUrl);
  return async function request(path, options = {}) {
    assert(typeof path === 'string' && path.startsWith('/'), 'http path must start with /');
    const headers = { ...(options.headers ?? {}) };
    if (options.token !== undefined) headers.Authorization = `Bearer ${options.token}`;
    const init = {
      method: options.method ?? 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    const response = await fetchImpl(`${base}${path}`, init);
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, headers: response.headers, text, json };
  };
}

export let http = createHttpClient(DEFAULT_GATEWAY_BASE_URL);

export function setBaseUrl(raw) {
  http = createHttpClient(raw);
  return http;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameItems(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) {
    return false;
  }
  const normalize = (items) => items
    .map((item) => ({
      partId: typeof item?.partId === 'string' ? item.partId.toLowerCase() : item?.partId,
      quantity: item?.quantity,
    }))
    .sort((left, right) => String(left.partId).localeCompare(String(right.partId)));
  return JSON.stringify(normalize(actual)) === JSON.stringify(normalize(expected));
}

function assertExactKeys(value, keys, step, label) {
  assert(isRecord(value), `${step}: ${label} is not an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${step}: ${label} keys changed (${actual.join(',')})`,
  );
}

export function assertSummaryProjection(body, step = 'summary') {
  assertExactKeys(body, ['orderId', 'partial', 'payment', 'dispatch'], step, 'summary');
  if (body.payment?.availability === 'available') {
    assertExactKeys(body.payment, ['availability', 'data'], step, 'payment');
    assertExactKeys(body.payment.data, ['orderId', 'status'], step, 'payment.data');
  } else {
    assertExactKeys(body.payment, ['availability'], step, 'payment');
  }
  if (body.dispatch?.availability === 'available') {
    assertExactKeys(body.dispatch, ['availability', 'data'], step, 'dispatch');
    assertExactKeys(body.dispatch.data, ['orderId', 'status', 'items'], step, 'dispatch.data');
    assert(Array.isArray(body.dispatch.data.items), `${step}: dispatch.items is not an array`);
    for (const item of body.dispatch.data.items) {
      assertExactKeys(item, ['partId', 'quantity'], step, 'dispatch.items[]');
    }
  } else {
    assertExactKeys(body.dispatch, ['availability'], step, 'dispatch');
  }
}

export function assertSummary(response, expected, step = 'summary') {
  assert(isRecord(response), `${step}: response missing`);
  assert(
    Array.isArray(expected.statuses) && expected.statuses.includes(response.status),
    `${step}: expected HTTP ${expected.statuses.join(' or ')}, got ${response.status}`,
  );
  const body = response.json;
  assert(isRecord(body), `${step}: response body is not an object`);
  if (response.status === 200) assertSummaryProjection(body, step);

  if (expected.codes === undefined) {
    assert(body.code === undefined, `${step}: unexpected error code ${String(body.code)}`);
  } else {
    assert(
      expected.codes.includes(body.code),
      `${step}: expected code ${expected.codes.join(' or ')}, got ${body.code ?? 'none'}`,
    );
  }

  if (expected.partial !== undefined) {
    assert(body.partial === expected.partial, `${step}: expected partial ${expected.partial}`);
  }
  if (expected.orderId !== undefined) {
    assert(body.orderId === expected.orderId, `${step}: summary orderId changed`);
  }

  if (expected.paymentAvailability !== undefined) {
    assert(
      body.payment?.availability === expected.paymentAvailability,
      `${step}: expected payment ${expected.paymentAvailability}, got ${body.payment?.availability ?? 'none'}`,
    );
    if (expected.paymentAvailability === 'available') {
      assert(isRecord(body.payment.data), `${step}: available payment without data`);
      if (expected.paymentStatus !== undefined) {
        assert(body.payment.data.status === expected.paymentStatus, `${step}: payment status changed`);
      }
    } else {
      assert(body.payment?.data === undefined, `${step}: unavailable payment exposed data`);
    }
  }

  if (expected.dispatchAvailability !== undefined) {
    assert(
      body.dispatch?.availability === expected.dispatchAvailability,
      `${step}: expected dispatch ${expected.dispatchAvailability}, got ${body.dispatch?.availability ?? 'none'}`,
    );
    if (expected.dispatchAvailability === 'available') {
      assert(isRecord(body.dispatch.data), `${step}: available dispatch without data`);
      if (expected.orderId !== undefined) {
        assert(body.dispatch.data.orderId === expected.orderId, `${step}: dispatch orderId changed`);
      }
      if (expected.dispatchStatus !== undefined) {
        assert(body.dispatch.data.status === expected.dispatchStatus, `${step}: dispatch status changed`);
      }
      if (expected.items !== undefined) {
        assert(sameItems(body.dispatch.data.items, expected.items), `${step}: dispatch items changed`);
      }
    } else {
      assert(body.dispatch?.data === undefined, `${step}: unavailable dispatch exposed data`);
    }
  }

  if (expected.sources !== undefined) {
    assert(isRecord(body.details) && isRecord(body.details.sources), `${step}: missing details.sources`);
    assert(
      body.details.sources.payment === expected.sources.payment,
      `${step}: unexpected payment source ${body.details.sources.payment}`,
    );
    assert(
      body.details.sources.dispatch === expected.sources.dispatch,
      `${step}: unexpected dispatch source ${body.details.sources.dispatch}`,
    );
  }

  if (expected.forbidPaymentStatus !== undefined) {
    assert(
      body.payment?.data?.status !== expected.forbidPaymentStatus,
      `${step}: payment ${expected.forbidPaymentStatus} must not appear without Pagos`,
    );
    assert(
      !String(response.text ?? '').includes(expected.forbidPaymentStatus),
      `${step}: response exposed ${expected.forbidPaymentStatus}`,
    );
  }

  return body;
}

async function waitForStatus(path, expected, step, attempts = 30) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await http(path);
      if (response.status === expected) return response;
    } catch {
      // The stack may still be starting; retry with a bounded delay.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${step}: did not reach HTTP ${expected}`);
}

export async function cancelOrder({
  orderId,
  token,
  request = http,
  warn = console.warn,
} = {}) {
  if (orderId === undefined) return { ok: true, skipped: true };
  if (token === undefined) {
    warn(`[warn] order ${orderId} cleanup pending: no operator token`);
    return { ok: false, reason: 'no-token' };
  }
  try {
    const response = await request(`/v1/orders/${orderId}/cancel`, { method: 'POST', token });
    if (response.status !== 200) {
      warn(`[warn] order ${orderId} cleanup pending: HTTP ${response.status}`);
      return { ok: false, reason: `http-${response.status}` };
    }
    const status = response.json?.status;
    if (status !== 'CANCELLED') {
      warn(`[warn] order ${orderId} cleanup pending: status ${status ?? 'none'}`);
      return { ok: false, reason: 'not-cancelled' };
    }
    return { ok: true };
  } catch (error) {
    const name = error instanceof Error ? error.name : 'UnknownError';
    warn(`[warn] order ${orderId} cleanup pending: ${name}`);
    return { ok: false, reason: 'exception' };
  }
}

export function cancelDispatch({ orderId, run = runDocker, warn = console.warn } = {}) {
  if (orderId === undefined) return { ok: true, skipped: true };
  const url = JSON.stringify(`http://127.0.0.1:3001/internal/v1/dispatches/${orderId}/cancel`);
  const script = `try { const response = await fetch(${url}, { method: 'POST', signal: AbortSignal.timeout(5000) }); const body = await response.json().catch(() => undefined); process.exit(response.status === 200 && body?.status === 'CANCELLED' ? 0 : 2); } catch { process.exit(3); }`;
  try {
    const result = run(
      ['exec', '-T', 'dispatch-api', 'node', '--input-type=module', '-e', script],
      10_000,
    );
    if (result.status !== 0) {
      warn(`[warn] dispatch ${orderId} cleanup pending: exit ${result.status}`);
      return { ok: false, reason: `exit-${result.status}` };
    }
    return { ok: true };
  } catch (error) {
    const name = error instanceof Error ? error.name : 'UnknownError';
    warn(`[warn] dispatch ${orderId} cleanup pending: ${name}`);
    return { ok: false, reason: 'exception' };
  }
}

export function windowIndex(nowMs, windowMs) {
  return Math.floor(nowMs / windowMs);
}

export function resolveRateLimitConfig(configuredLimit, configuredWindow) {
  const limit = configuredLimit === undefined || configuredLimit === ''
    ? DEFAULT_RATE_LIMIT_MAX_REQUESTS
    : Number(configuredLimit);
  const windowMs = configuredWindow === undefined || configuredWindow === ''
    ? DEFAULT_RATE_LIMIT_WINDOW_MS
    : Number(configuredWindow);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('rate limit: invalid configured maximum');
  }
  if (!Number.isSafeInteger(windowMs) || windowMs < 1) {
    throw new Error('rate limit: invalid configured window');
  }
  if (windowMs < 5_000) {
    return { skipReason: `configured window ${windowMs}ms is too short for a stable smoke` };
  }
  if (limit > MAX_RATE_LIMIT_REQUESTS) {
    return { skipReason: `configured ${limit} exceeds the bounded smoke maximum ${MAX_RATE_LIMIT_REQUESTS}` };
  }
  return { limit, windowMs };
}

function statusSummary(statuses) {
  const counts = new Map();
  for (const status of statuses) counts.set(status, (counts.get(status) ?? 0) + 1);
  return [...counts.entries()].map(([status, count]) => `${count}x${status}`).join(',');
}

export async function runRateLimitCheck({
  limit,
  windowMs,
  makeToken,
  request,
  now = Date.now,
  log = () => {},
  maxRounds = MAX_RATE_LIMIT_ROUNDS,
  maxTotalRequests = MAX_RATE_LIMIT_TOTAL_REQUESTS,
}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RATE_LIMIT_REQUESTS) {
    throw new Error(`rate limit: limit must be between 1 and ${MAX_RATE_LIMIT_REQUESTS}`);
  }
  if (!Number.isSafeInteger(windowMs) || windowMs < 1) {
    throw new Error('rate limit: window must be a positive integer');
  }
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > MAX_RATE_LIMIT_ROUNDS) {
    throw new Error(`rate limit: maxRounds must be between 1 and ${MAX_RATE_LIMIT_ROUNDS}`);
  }
  if (!Number.isSafeInteger(maxTotalRequests) || maxTotalRequests < limit + 1) {
    throw new Error('rate limit: total request budget is too small');
  }

  let totalRequests = 0;
  for (let round = 1; round <= maxRounds; round += 1) {
    const token = await makeToken(round);
    const windows = new Set();
    windows.add(windowIndex(now(), windowMs));
    const statuses = [];
    let lastResponse;

    for (let index = 0; index < limit + 1; index += 1) {
      if (totalRequests >= maxTotalRequests) {
        throw new Error(`rate limit: total request budget ${maxTotalRequests} exceeded`);
      }
      const response = await request('/v1/customers', { token });
      totalRequests += 1;
      statuses.push(response.status);
      lastResponse = response;
      windows.add(windowIndex(now(), windowMs));
    }
    windows.add(windowIndex(now(), windowMs));

    const exact = statuses.slice(0, limit).every((status) => status === 200)
      && statuses[limit] === 429;
    if (exact) {
      return {
        rounds: round,
        totalRequests,
        lastResponse,
        reason: round === 1
          ? 'exact quota in one window'
          : 'exact quota after a window-crossing retry',
      };
    }

    if (windows.size === 1) {
      throw new Error(
        `rate limit: expected ${limit} HTTP 200 and one HTTP 429 in the same window; got ${statusSummary(statuses)}`,
      );
    }
    if (round === maxRounds) {
      throw new Error(
        `rate limit: window crossed in both allowed rounds; got ${statusSummary(statuses)}`,
      );
    }
    log(`[info] rate limit: window crossed during round ${round}; retrying once with a fresh identity`);
  }

  throw new Error('rate limit: no completed round');
}

export async function cleanupArtifacts({
  orderId,
  summaryId,
  dispatchId,
  token,
  cancelOrderFn = cancelOrder,
  cancelDispatchFn = cancelDispatch,
} = {}) {
  let pending = false;
  let attempted = false;

  if (orderId !== undefined) {
    attempted = true;
    try {
      const result = await cancelOrderFn({ orderId, token });
      if (!result.ok) pending = true;
    } catch {
      pending = true;
    }
  }
  if (summaryId !== undefined) {
    attempted = true;
    try {
      const result = await cancelOrderFn({ orderId: summaryId, token });
      if (!result.ok) pending = true;
    } catch {
      pending = true;
    }
  }
  if (dispatchId !== undefined) {
    attempted = true;
    try {
      const result = await cancelDispatchFn({ orderId: dispatchId });
      if (!result.ok) pending = true;
    } catch {
      pending = true;
    }
  }

  return { pending, attempted };
}

async function cleanupAll() {
  return cleanupArtifacts({
    orderId: createdOrderId,
    summaryId: summaryOrderId,
    dispatchId: dispatchOrderId,
    token: operatorToken,
  });
}

async function createOrder({
  body,
  key,
  step,
  onId,
}) {
  let response;
  try {
    response = await http('/v1/orders', {
      method: 'POST',
      token: operatorToken,
      headers: { 'Idempotency-Key': key },
      body,
    });
  } catch {
    console.error(`[recovery] Idempotency-Key=${key}`);
    throw new Error(`${step}: create order ambiguous; recovery pending by Idempotency-Key`);
  }
  const id = typeof response.json?.id === 'string' ? response.json.id : undefined;
  if (id !== undefined) onId(id);
  if (response.status >= 500 && id === undefined) {
    console.error(`[recovery] Idempotency-Key=${key}`);
    throw new Error(`${step}: create order ambiguous (5xx without ID); recovery pending by Idempotency-Key`);
  }
  return response;
}

export function assertStockSummary(response, step) {
  assertSummary(response, {
    statuses: [404],
    codes: ['SUMMARY_NOT_FOUND'],
    forbidPaymentStatus: 'CHARGED',
  }, step);
}

export async function main() {
  assert(existsSync('docker-compose.yml'), 'run this script from the repository root');
  assert(existsSync('docker-compose.p4.yml'), 'run this script from the repository root');
  operatorToken = process.env.GATEWAY_OPERATOR_TOKEN?.trim() || undefined;
  readerToken = process.env.GATEWAY_READER_TOKEN?.trim() || undefined;
  createdOrderId = undefined;
  summaryOrderId = undefined;
  dispatchOrderId = undefined;
  setBaseUrl(process.env.GATEWAY_BASE_URL ?? DEFAULT_GATEWAY_BASE_URL);

  const actualSteps = readContainerEnv('sales-api', 'SAGA_STEPS');
  const mode = resolveSmokeMode({
    actual: actualSteps,
    expected: process.env.P4_SMOKE_EXPECT_STEPS,
  });
  console.log(`[ok] SAGA_STEPS real=${mode} (detected before mutations)`);
  if (mode === 'stock') {
    console.log('[info] modo stock: sin cobro ni despacho; Pagos not_found y Despacho not_found');
  } else if (mode === 'stock,dispatch') {
    console.log('[info] modo stock,dispatch: sin cobro; Pagos not_found y Despacho real');
  } else {
    console.log('[info] modo stock,payment,dispatch: Pagos real con pasarela simulada y Despacho real');
  }

  const health = await waitForStatus('/health', 200, 'gateway health');
  expectStatus(health, 200, 'gateway health');
  assert(health.json?.service === 'gateway', 'gateway health: unexpected service');
  console.log('[ok] gateway health 200');

  const salesHealth = await waitForStatus('/v1/health', 200, 'sales health');
  expectStatus(salesHealth, 200, 'sales health');
  assert(salesHealth.json?.service === 'sales-api', 'sales health: unexpected service');
  console.log('[ok] Sales health through Gateway 200');

  const missing = await http('/v1/customers');
  expectStatus(missing, 401, 'missing token');
  assert(
    (missing.headers.get('www-authenticate') ?? '').toLowerCase().includes('bearer'),
    'missing token: WWW-Authenticate Bearer absent',
  );
  console.log('[ok] missing token -> 401 with Bearer challenge');

  if (operatorToken === undefined || readerToken === undefined) {
    const subject = `p4-smoke-${Date.now()}-${randomUUID().slice(0, 8)}`;
    operatorToken ??= tokenFromCli('operator', `${subject}-operator`);
    readerToken ??= tokenFromCli('reader', `${subject}-reader`);
    console.log('[ok] tokens obtained from the container CLI (not printed)');
  } else {
    console.log('[ok] external reader/operator tokens supplied');
  }

  const readerGet = await http('/v1/customers', { token: readerToken });
  expectStatus(readerGet, 200, 'reader GET');

  const readerPost = await http('/v1/customers', {
    method: 'POST',
    token: readerToken,
    body: { name: 'P4 smoke reader', email: `p4-reader-${Date.now()}@example.invalid` },
  });
  expectStatus(readerPost, 403, 'reader POST');
  expectCode(readerPost, 'FORBIDDEN', 'reader POST');
  console.log('[ok] reader GET 200 and reader POST 403');

  const customer = await http('/v1/customers', {
    method: 'POST',
    token: operatorToken,
    body: {
      name: 'P4 smoke customer',
      email: `p4-smoke-${Date.now()}-${randomUUID().slice(0, 8)}@example.invalid`,
    },
  });
  expectStatus(customer, 201, 'operator customer');
  const customerId = customer.json?.id;
  assertUuid(customerId, 'operator customer');
  console.log('[ok] operator customer 201');

  const orderBody = { customerId, items: [{ partId: PART_ID, quantity: 1 }] };
  const idempotencyKey = `p4-smoke-order-${randomUUID()}`;
  const order = await createOrder({
    body: orderBody,
    key: idempotencyKey,
    step: 'create order',
    onId: (id) => { createdOrderId = id; },
  });
  expectStatus(order, 201, 'create order');
  assert(order.json?.status === 'CONFIRMED', 'create order: expected CONFIRMED');
  assertUuid(createdOrderId, 'create order');
  const firstOrderBody = JSON.stringify(order.json);
  console.log('[ok] order created 201 CONFIRMED');

  const replay = await http('/v1/orders', {
    method: 'POST',
    token: operatorToken,
    headers: { 'Idempotency-Key': idempotencyKey },
    body: orderBody,
  });
  expectStatus(replay, 201, 'order replay');
  assert(
    (replay.headers.get('idempotency-replayed') ?? '').toLowerCase() === 'true',
    'order replay: Idempotency-Replayed true absent',
  );
  assert(replay.json?.id === createdOrderId, 'order replay: orderId changed');
  assert(JSON.stringify(replay.json) === firstOrderBody, 'order replay: body changed');
  console.log('[ok] idempotent replay 201 with same orderId, body and Idempotency-Replayed');

  const changed = await http('/v1/orders', {
    method: 'POST',
    token: operatorToken,
    headers: { 'Idempotency-Key': idempotencyKey },
    body: { ...orderBody, items: [{ partId: PART_ID, quantity: 2 }] },
  });
  expectStatus(changed, 409, 'idempotency conflict');
  expectCode(changed, 'IDEMPOTENCY_KEY_CONFLICT', 'idempotency conflict');
  console.log('[ok] changed payload with same key -> 409 IDEMPOTENCY_KEY_CONFLICT');

  if (mode === 'stock') {
    const cancelFirst = await http(`/v1/orders/${createdOrderId}/cancel`, {
      method: 'POST',
      token: operatorToken,
    });
    expectStatus(cancelFirst, 200, 'first cancel');
    assert(cancelFirst.json?.status === 'CANCELLED', 'first cancel: expected CANCELLED');

    const cancelSecond = await http(`/v1/orders/${createdOrderId}/cancel`, {
      method: 'POST',
      token: operatorToken,
    });
    expectStatus(cancelSecond, 200, 'second cancel');
    assert(cancelSecond.json?.status === 'CANCELLED', 'second cancel: expected CANCELLED');
    console.log('[ok] cancel twice -> 200 CANCELLED');

    const summaryOrder = await createOrder({
      body: { customerId, items: [{ partId: PART_ID, quantity: 1 }] },
      key: `p4-smoke-summary-${randomUUID()}`,
      step: 'summary order',
      onId: (id) => { summaryOrderId = id; },
    });
    expectStatus(summaryOrder, 201, 'summary order');
    assertUuid(summaryOrderId, 'summary order');
    assert(summaryOrder.json?.status === 'CONFIRMED', 'summary order: expected CONFIRMED');

    const summary = await http(`/web/v1/orders/${summaryOrderId}/summary`, { token: readerToken });
    assertStockSummary(summary, 'summary stock');
    console.log(`[ok] summary stock -> ${summary.status} ${codeOf(summary)} without CHARGED`);
  } else {
    const full = mode === 'stock,payment,dispatch';
    const paymentAvailability = full ? 'available' : 'not_found';
    const partial = !full;
    const beforeExpectation = {
      statuses: [200],
      partial,
      paymentAvailability,
      ...(full ? { paymentStatus: 'CHARGED' } : { forbidPaymentStatus: 'CHARGED' }),
      dispatchAvailability: 'available',
      dispatchStatus: 'CREATED',
      orderId: createdOrderId,
      items: orderBody.items,
    };
    const cancelledExpectation = {
      ...beforeExpectation,
      ...(full ? { paymentStatus: 'REFUNDED' } : {}),
      dispatchStatus: 'CANCELLED',
    };

    const summary = await http(`/web/v1/orders/${createdOrderId}/summary`, { token: readerToken });
    assertSummary(summary, beforeExpectation, `${mode} summary`);

    const summaryAgain = await http(`/web/v1/orders/${createdOrderId}/summary`, { token: readerToken });
    assertSummary(summaryAgain, beforeExpectation, `${mode} summary query`);
    assert(
      JSON.stringify(summaryAgain.json) === JSON.stringify(summary.json),
      `${mode} summary: repeated query changed`,
    );

    const salesBeforeCancel = await http(`/v1/orders/${createdOrderId}`, { token: readerToken });
    expectStatus(salesBeforeCancel, 200, 'sales order before cancel');
    assert(salesBeforeCancel.json?.status === 'CONFIRMED', 'sales order before cancel: expected CONFIRMED');
    console.log(
      `[ok] ${mode} summary 200 partial:${partial} payment ${paymentAvailability}`
      + `${full ? ' CHARGED' : ''} dispatch CREATED, same orderId/items, stable query`,
    );

    const cancelFirst = await http(`/v1/orders/${createdOrderId}/cancel`, {
      method: 'POST',
      token: operatorToken,
    });
    expectStatus(cancelFirst, 200, 'first cancel');
    assert(cancelFirst.json?.status === 'CANCELLED', 'first cancel: expected CANCELLED');

    const cancelSecond = await http(`/v1/orders/${createdOrderId}/cancel`, {
      method: 'POST',
      token: operatorToken,
    });
    expectStatus(cancelSecond, 200, 'second cancel');
    assert(cancelSecond.json?.status === 'CANCELLED', 'second cancel: expected CANCELLED');

    const cancelledSummary = await http(`/web/v1/orders/${createdOrderId}/summary`, { token: readerToken });
    assertSummary(cancelledSummary, cancelledExpectation, `cancelled ${mode} summary`);

    const salesCancelled = await http(`/v1/orders/${createdOrderId}`, { token: readerToken });
    expectStatus(salesCancelled, 200, 'sales order after cancel');
    assert(salesCancelled.json?.status === 'CANCELLED', 'sales order after cancel: expected CANCELLED');
    console.log(
      `[ok] cancel twice -> Sales CANCELLED, payment ${full ? 'REFUNDED' : 'not_found'}, `
      + 'dispatch CANCELLED',
    );
  }

  const rateConfig = resolveRateLimitConfig(
    readContainerEnv('api-gateway', 'GATEWAY_RATE_LIMIT_MAX_REQUESTS', { allowEmpty: true }),
    readContainerEnv('api-gateway', 'GATEWAY_RATE_LIMIT_WINDOW_MS', { allowEmpty: true }),
  );
  if (rateConfig.skipReason !== undefined) {
    console.log(`[skip] rate limit: ${rateConfig.skipReason}`);
  } else {
    const rateResult = await runRateLimitCheck({
      limit: rateConfig.limit,
      windowMs: rateConfig.windowMs,
      makeToken: (round) => tokenFromCli('reader', `p4-smoke-rate-${randomUUID()}-${round}`),
      request: (path, options) => http(path, options),
      now: () => Date.now(),
      log: (message) => console.log(message),
    });
    expectCode(rateResult.lastResponse, 'RATE_LIMIT_EXCEEDED', 'rate limit rejection');
    const retryAfter = Number(rateResult.lastResponse.headers.get('retry-after'));
    assert(Number.isSafeInteger(retryAfter) && retryAfter >= 1, 'rate limit: invalid Retry-After');
    console.log(
      `[ok] rate limit: ${rateConfig.limit} allowed + 1 rejected in ${rateResult.rounds} round(s), `
      + `total ${rateResult.totalRequests}; ${rateResult.reason}; Retry-After ${retryAfter}s`,
    );
  }

  if (process.env.P4_SMOKE_DISPATCH_FIXTURE !== 'true') {
    console.log('[skip] dispatch fixture: set P4_SMOKE_DISPATCH_FIXTURE=true to create one isolated dispatch');
  } else if (mode !== 'stock') {
    console.log('[skip] dispatch fixture: only used in stock mode; stock,dispatch creates a real dispatch');
  } else if (readContainerEnv('dispatch-api', 'DISPATCH_FAIL_CREATE') === 'true') {
    console.log('[skip] dispatch fixture: DISPATCH_FAIL_CREATE=true is already active');
  } else {
    dispatchOrderId = randomUUID();
    const dispatchUrl = JSON.stringify(`http://127.0.0.1:3001/internal/v1/dispatches/${dispatchOrderId}`);
    const createScript = `const response = await fetch(${dispatchUrl}, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: [{ partId: ${JSON.stringify(PART_ID)}, quantity: 1 }] }) }); process.exit(response.ok ? 0 : 1);`;
    const created = runDocker([
      'exec',
      '-T',
      'dispatch-api',
      'node',
      '--input-type=module',
      '-e',
      createScript,
    ]);
    if (created.status !== 0) throw new Error('dispatch fixture: create failed');

    const fixtureSummary = await http(`/web/v1/orders/${dispatchOrderId}/summary`, {
      token: readerToken,
    });
    assertSummary(fixtureSummary, {
      statuses: [200],
      partial: true,
      paymentAvailability: 'not_found',
      dispatchAvailability: 'available',
      dispatchStatus: 'CREATED',
      orderId: dispatchOrderId,
      items: [{ partId: PART_ID, quantity: 1 }],
      forbidPaymentStatus: 'CHARGED',
    }, 'dispatch fixture summary');
    console.log('[ok] isolated dispatch fixture summary 200 partial (not Saga evidence)');
  }

  console.log('[ok] P4 smoke complete');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let exitCode = 0;
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error(`[fail] ${message}`);
    exitCode = 1;
  } finally {
    let cleanup = { pending: true, attempted: true };
    try {
      cleanup = await cleanupAll();
    } catch {
      console.error('[warn] cleanup pending: unexpected cleanup failure');
    }
    if (cleanup.pending) {
      console.error('[warn] cleanup pending; recovery may be needed (see UUID warnings)');
      exitCode = 1;
    } else if (cleanup.attempted) {
      console.log('[info] smoke finished; all created test orders/dispatch confirmed CANCELLED');
    } else {
      console.log('[info] smoke finished; no test artifacts to cancel');
    }
  }
  process.exitCode = exitCode;
}
