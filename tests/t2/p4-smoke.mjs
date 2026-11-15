#!/usr/bin/env node
// P4 system smoke. Run from the repository root:
//   node tests/t2/p4-smoke.mjs
// Optional: GATEWAY_BASE_URL, GATEWAY_READER_TOKEN, GATEWAY_OPERATOR_TOKEN,
//           P4_SMOKE_DISPATCH_FIXTURE=true.
// Tokens are never printed. The script cancels its test orders/dispatch in finally.

import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const BASE = (process.env.GATEWAY_BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
const COMPOSE = ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.p4.yml'];
const PART_ID = 'e58e2904-9db7-4c8d-8f36-7107e863a268';
const HTTP_TIMEOUT_MS = 5_000;
const CLI_TIMEOUT_MS = 20_000;
const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 60;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_RATE_LIMIT_REQUESTS = 1_000;
const MAX_RATE_LIMIT_ROUNDS = 2;
const MAX_RATE_LIMIT_TOTAL_REQUESTS = MAX_RATE_LIMIT_ROUNDS * (MAX_RATE_LIMIT_REQUESTS + 1);

let operatorToken = process.env.GATEWAY_OPERATOR_TOKEN?.trim() || undefined;
let readerToken = process.env.GATEWAY_READER_TOKEN?.trim() || undefined;
let createdOrderId;
let summaryOrderId;
let dispatchOrderId;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function expectStatus(response, expected, step) {
  if (response.status !== expected) {
    throw new Error(`${step}: expected HTTP ${expected}, got ${response.status}`);
  }
}

function codeOf(response) {
  return response.json !== null && typeof response.json === 'object'
    ? response.json.code
    : undefined;
}

function expectCode(response, expected, step) {
  const code = codeOf(response);
  if (code !== expected) throw new Error(`${step}: expected code ${expected}, got ${code ?? 'none'}`);
}

function assertUuid(value, step) {
  assert(
    typeof value === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
    `${step}: expected UUID`,
  );
}

function runDocker(args, timeoutMs = CLI_TIMEOUT_MS) {
  const result = spawnSync('docker', [...COMPOSE, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    shell: false,
    maxBuffer: 1024 * 1024,
  });
  if (result.error !== undefined) {
    throw new Error(`docker command failed: ${result.error.name}`);
  }
  return result;
}

function tokenFromCli(role, subject) {
  const result = runDocker([
    'exec',
    '-T',
    'api-gateway',
    'node',
    'dist/src/cli/token.js',
    '--sub',
    subject,
    '--role',
    role,
  ]);
  if (result.status !== 0) {
    throw new Error(`token CLI failed for ${role}; rebuild the P4 images with the overlay`);
  }
  const token = result.stdout.trim();
  assert(token.split('.').length === 3, `token CLI for ${role} returned an invalid token`);
  return token;
}

function readContainerEnv(service, name) {
  const result = runDocker([
    'exec',
    '-T',
    service,
    'node',
    '--input-type=module',
    '-e',
    `process.stdout.write(process.env.${name} ?? '')`,
  ], 10_000);
  return result.status === 0 ? result.stdout.trim() : '';
}

async function http(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.token !== undefined) headers.Authorization = `Bearer ${options.token}`;
  const init = {
    method: options.method ?? 'GET',
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(`${BASE}${path}`, init);
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, text, json };
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
      const result = cancelDispatchFn({ orderId: dispatchId });
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

export async function main() {
  assert(existsSync('docker-compose.p4.yml'), 'run this script from the repository root');

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
  let order;
  try {
    order = await http('/v1/orders', {
      method: 'POST',
      token: operatorToken,
      headers: { 'Idempotency-Key': idempotencyKey },
      body: orderBody,
    });
  } catch {
    throw new Error('create order ambiguous; recovery pending by Idempotency-Key');
  }
  if (typeof order.json?.id === 'string') createdOrderId = order.json.id;
  if (order.status >= 500 && createdOrderId === undefined) {
    throw new Error('create order ambiguous (5xx without ID); recovery pending by Idempotency-Key');
  }
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
  assert(JSON.stringify(replay.json) === firstOrderBody, 'order replay: body changed');
  console.log('[ok] idempotent replay 201 with same body and Idempotency-Replayed');

  const changed = await http('/v1/orders', {
    method: 'POST',
    token: operatorToken,
    headers: { 'Idempotency-Key': idempotencyKey },
    body: { ...orderBody, items: [{ partId: PART_ID, quantity: 2 }] },
  });
  expectStatus(changed, 409, 'idempotency conflict');
  expectCode(changed, 'IDEMPOTENCY_KEY_CONFLICT', 'idempotency conflict');
  console.log('[ok] changed payload with same key -> 409 IDEMPOTENCY_KEY_CONFLICT');

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
  createdOrderId = undefined;
  console.log('[ok] cancel twice -> 200 CANCELLED');

  let summaryOrder;
  try {
    summaryOrder = await http('/v1/orders', {
      method: 'POST',
      token: operatorToken,
      headers: { 'Idempotency-Key': `p4-smoke-summary-${randomUUID()}` },
      body: { customerId, items: [{ partId: PART_ID, quantity: 1 }] },
    });
  } catch {
    throw new Error('summary order ambiguous; recovery pending by Idempotency-Key');
  }
  if (typeof summaryOrder.json?.id === 'string') summaryOrderId = summaryOrder.json.id;
  if (summaryOrder.status >= 500 && summaryOrderId === undefined) {
    throw new Error('summary order ambiguous (5xx without ID); recovery pending by Idempotency-Key');
  }
  expectStatus(summaryOrder, 201, 'summary order');
  assertUuid(summaryOrderId, 'summary order');
  assert(summaryOrder.json?.status === 'CONFIRMED', 'summary order: expected CONFIRMED');

  const summary = await http(`/web/v1/orders/${summaryOrderId}/summary`, { token: readerToken });
  assert(
    summary.status === 503 || summary.status === 404,
    `summary without Pagos/Dispatch: expected 503 or 404, got ${summary.status}`,
  );
  assert(
    codeOf(summary) === 'UPSTREAM_UNAVAILABLE' || codeOf(summary) === 'SUMMARY_NOT_FOUND',
    'summary without Pagos/Dispatch: unexpected error code',
  );
  if (summary.status === 503) {
    assert(
      summary.json?.details?.sources !== undefined,
      'summary 503 did not come from the BFF (missing details.sources)',
    );
  }
  assert(!summary.text.includes('CHARGED'), 'summary without Pagos/Dispatch exposed CHARGED');
  console.log(`[ok] summary without Pagos/Dispatch -> ${summary.status} ${codeOf(summary)} without CHARGED`);

  const rateConfig = resolveRateLimitConfig(
    readContainerEnv('api-gateway', 'GATEWAY_RATE_LIMIT_MAX_REQUESTS'),
    readContainerEnv('api-gateway', 'GATEWAY_RATE_LIMIT_WINDOW_MS'),
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
    expectStatus(fixtureSummary, 200, 'dispatch fixture summary');
    assert(fixtureSummary.json?.partial === true, 'dispatch fixture summary: expected partial true');
    assert(
      fixtureSummary.json?.payment?.availability === 'unavailable',
      'dispatch fixture summary: expected payment unavailable',
    );
    assert(
      fixtureSummary.json?.dispatch?.availability === 'available',
      'dispatch fixture summary: expected dispatch available',
    );
    assert(
      fixtureSummary.json?.dispatch?.data?.status === 'CREATED',
      'dispatch fixture summary: expected dispatch CREATED',
    );
    assert(!fixtureSummary.text.includes('CHARGED'), 'dispatch fixture summary exposed CHARGED');
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
