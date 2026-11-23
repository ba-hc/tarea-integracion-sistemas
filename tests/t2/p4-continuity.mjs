#!/usr/bin/env node
// P4 E3 continuity probe. Run from the repository root against an already
// running full stack:
//   P4_TEST_PROJECT=repuestossur-p4-final P4_TEST_PORT=8082 \
//     node tests/t2/p4-continuity.mjs
//
// It is a small mechanism test, not a load test. It recreates only payments-api
// before each repetition, toggles its Circuit Breaker/Bulkhead flags, and uses
// the payment simulator admin API inside its container. It never starts the
// stack, never restarts the simulator, never deletes volumes and never targets a
// remote URL. Run it alone: no smoke or load test concurrently.

import { randomUUID } from 'node:crypto';
import { cpus, platform, release } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  buildGatewayConfigScript,
  getPartStock,
  preflight,
  resolveConfig,
  runComposeSync,
  runComposeUp,
} from './p4-independent.mjs';
import {
  assert,
  assertUuid,
  cancelOrder,
  createHttpClient,
  readContainerEnv,
  tokenFromCli,
} from './p4-smoke.mjs';

const BULKHEAD_PART_ID = 'd6e1fd98-cb07-458f-aa12-6fe220b37604';
const SEED_PART_ID = 'e58e2904-9db7-4c8d-8f36-7107e863a268';
const TIMEOUT_MS = 1_200;
const BULKHEAD_CAP = 2;
const SLOW_DELAY_MS = 650;
const BULKHEAD_BURST = 6;
const CB_ORDERS = 8;
const REPETITIONS = 3;
const PAYMENTS_RECREATE_ARGS = Object.freeze([
  'up', '--no-build', '-d', '--wait', '--wait-timeout', '180',
  '--no-deps', '--force-recreate', 'payments-api',
]);
const SIM_MODES = Object.freeze(['normal', 'slow', 'down', 'decline']);

export function parseArgs(argv = []) {
  if (argv.length === 0) return { help: false };
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return { help: true };
  throw new Error(`unknown argument: ${argv.join(' ')}`);
}

export function usage() {
  return [
    'Usage:',
    '  P4_TEST_PROJECT=repuestossur-p4-final P4_TEST_PORT=8082 \\',
    '    node tests/t2/p4-continuity.mjs',
    '',
    'Requires an already running full stack with SAGA_STEPS=stock,payment,dispatch,',
    'DISPATCH_FAIL_CREATE=false and normal payments flags (CB=true, BH=true, cap=8, timeout=1200).',
    'It recreates only payments-api before each repetition:',
    `  docker compose -f docker-compose.yml -f docker-compose.p4.yml ${PAYMENTS_RECREATE_ARGS.join(' ')}`,
    'with PAYMENTS_CIRCUIT_BREAKER_ENABLED, PAYMENTS_BULKHEAD_ENABLED,',
    'PAYMENTS_BULKHEAD_MAX_CONCURRENT and PAYMENTS_GATEWAY_TIMEOUT_MS in the child env.',
    'Simulator admin GET/PUT and Pagos resilience GET run via docker compose exec inside',
    'payment-gateway-sim/payments-api. No host admin port is used.',
    'Run exclusively: no smoke, load or other project traffic at the same time.',
  ].join('\n');
}

function composeRun(config) {
  return (args, timeoutMs = 60_000) => runComposeSync(config, args, { timeoutMs });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseSimulatorConfig(raw) {
  let parsed;
  try {
    parsed = JSON.parse(String(raw ?? ''));
  } catch {
    throw new Error('simulator config is not valid JSON');
  }
  assert(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed), 'simulator config is not an object');
  assert(SIM_MODES.includes(parsed.mode), `simulator mode is invalid: ${parsed.mode ?? 'none'}`);
  for (const key of ['latencyMs', 'slowDelayMs']) {
    assert(
      Number.isSafeInteger(parsed[key]) && parsed[key] >= 0 && parsed[key] <= 120_000,
      `simulator ${key} is invalid`,
    );
  }
  assert(parsed.stats !== null && typeof parsed.stats === 'object' && !Array.isArray(parsed.stats), 'simulator stats are missing');
  const stats = {};
  for (const key of ['chargesApproved', 'refunds', 'voids', 'rejectedWhileDown']) {
    assert(
      Number.isSafeInteger(parsed.stats[key]) && parsed.stats[key] >= 0,
      `simulator stat ${key} is invalid`,
    );
    stats[key] = parsed.stats[key];
  }
  return { mode: parsed.mode, latencyMs: parsed.latencyMs, slowDelayMs: parsed.slowDelayMs, stats };
}

export function validateSimulatorPatch(patch) {
  assert(patch !== null && typeof patch === 'object' && !Array.isArray(patch), 'simulator patch is not an object');
  const allowed = new Set(['mode', 'latencyMs', 'slowDelayMs']);
  assert(Object.keys(patch).length > 0 && Object.keys(patch).every((key) => allowed.has(key)), 'simulator patch has unsupported fields');
  if (patch.mode !== undefined) assert(SIM_MODES.includes(patch.mode), 'simulator patch mode is invalid');
  for (const key of ['latencyMs', 'slowDelayMs']) {
    if (patch[key] !== undefined) {
      assert(
        Number.isSafeInteger(patch[key]) && patch[key] >= 0 && patch[key] <= 120_000,
        `simulator patch ${key} is invalid`,
      );
    }
  }
  return patch;
}

export function buildSimulatorWriteScript(patch) {
  validateSimulatorPatch(patch);
  return `
try {
  const response = await fetch('http://127.0.0.1:3010/admin/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: ${JSON.stringify(JSON.stringify(patch))},
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) process.exit(2);
  const body = await response.json();
  process.stdout.write(JSON.stringify(body), () => process.exit(0));
} catch {
  process.exit(3);
}
`;
}

export function readSimulatorConfig(config, { run = composeRun(config) } = {}) {
  const result = run([
    'exec', '-T', 'payment-gateway-sim', 'node', '--input-type=module', '-e',
    buildGatewayConfigScript(),
  ], 10_000);
  if (result.status !== 0) throw new Error(`simulator config read failed (exit ${result.status ?? 'unknown'})`);
  return parseSimulatorConfig(result.stdout);
}

export function writeSimulatorConfig(config, patch, { run = composeRun(config) } = {}) {
  validateSimulatorPatch(patch);
  const result = run([
    'exec', '-T', 'payment-gateway-sim', 'node', '--input-type=module', '-e',
    buildSimulatorWriteScript(patch),
  ], 10_000);
  if (result.status !== 0) throw new Error(`simulator config write failed (exit ${result.status ?? 'unknown'})`);
  const applied = readSimulatorConfig(config, { run });
  for (const [key, value] of Object.entries(patch)) {
    assert(applied[key] === value, `simulator did not apply ${key}`);
  }
  return applied;
}

export function parseResilience(raw) {
  let parsed;
  try {
    parsed = JSON.parse(String(raw ?? ''));
  } catch {
    throw new Error('payments resilience is not valid JSON');
  }
  assert(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed), 'payments resilience is not an object');
  assert(Number.isSafeInteger(parsed.gateway?.timeoutMs) && parsed.gateway.timeoutMs > 0, 'payments gateway timeout is invalid');
  assert(typeof parsed.circuitBreaker?.enabled === 'boolean', 'payments circuit enabled is invalid');
  assert(['CLOSED', 'OPEN', 'HALF_OPEN'].includes(parsed.circuitBreaker?.state), 'payments circuit state is invalid');
  assert(typeof parsed.bulkhead?.enabled === 'boolean', 'payments bulkhead enabled is invalid');
  const counters = {};
  for (const key of ['openedCount', 'rejectedCalls']) {
    assert(
      Number.isSafeInteger(parsed.circuitBreaker[key]) && parsed.circuitBreaker[key] >= 0,
      `payments circuit ${key} is invalid`,
    );
    counters[key] = parsed.circuitBreaker[key];
  }
  const bulkhead = {};
  for (const key of ['maxConcurrent', 'peakInFlight', 'rejectedCalls', 'inFlight']) {
    assert(
      Number.isSafeInteger(parsed.bulkhead[key]) && parsed.bulkhead[key] >= 0,
      `payments bulkhead ${key} is invalid`,
    );
    bulkhead[key] = parsed.bulkhead[key];
  }
  return {
    gatewayTimeoutMs: parsed.gateway.timeoutMs,
    circuit: {
      enabled: parsed.circuitBreaker.enabled,
      state: parsed.circuitBreaker.state,
      openedCount: counters.openedCount,
      rejectedCalls: counters.rejectedCalls,
    },
    bulkhead: {
      enabled: parsed.bulkhead.enabled,
      maxConcurrent: bulkhead.maxConcurrent,
      peakInFlight: bulkhead.peakInFlight,
      rejectedCalls: bulkhead.rejectedCalls,
      inFlight: bulkhead.inFlight,
    },
  };
}

export function readPaymentsResilience(config, { run = composeRun(config) } = {}) {
  const script = `
try {
  const response = await fetch('http://127.0.0.1:3003/internal/v1/resilience', {
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) process.exit(2);
  const body = await response.json();
  process.stdout.write(JSON.stringify(body), () => process.exit(0));
} catch {
  process.exit(3);
}
`;
  const result = run([
    'exec', '-T', 'payments-api', 'node', '--input-type=module', '-e', script,
  ], 10_000);
  if (result.status !== 0) throw new Error(`payments resilience read failed (exit ${result.status ?? 'unknown'})`);
  return parseResilience(result.stdout);
}

export function buildPaymentsEnv({ circuitBreaker, bulkhead, maxConcurrent, timeoutMs }) {
  return {
    PAYMENTS_CIRCUIT_BREAKER_ENABLED: String(circuitBreaker),
    PAYMENTS_BULKHEAD_ENABLED: String(bulkhead),
    PAYMENTS_BULKHEAD_MAX_CONCURRENT: String(maxConcurrent),
    PAYMENTS_GATEWAY_TIMEOUT_MS: String(timeoutMs),
  };
}

export async function recreatePayments(config, flags, {
  run = composeRun(config),
  runUp = runComposeUp,
  readResilience = () => readPaymentsResilience(config, { run }),
} = {}) {
  const env = { ...config.composeEnv, ...buildPaymentsEnv(flags) };
  const result = await runUp(config, [...PAYMENTS_RECREATE_ARGS], { env, timeoutMs: 6 * 60_000 });
  if (result.timedOut || result.code !== 0) {
    throw new Error(`payments-api recreate failed (${result.timedOut ? 'timeout' : `exit ${result.code ?? 'unknown'}`})`);
  }
  const snapshot = await readResilience();
  assert(snapshot.gatewayTimeoutMs === flags.timeoutMs, 'payments timeout was not applied');
  assert(snapshot.circuit.enabled === flags.circuitBreaker, 'payments circuit flag was not applied');
  assert(snapshot.bulkhead.enabled === flags.bulkhead, 'payments bulkhead flag was not applied');
  assert(snapshot.bulkhead.maxConcurrent === flags.maxConcurrent, 'payments bulkhead cap was not applied');
  return snapshot;
}

export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function summarizeLatencies(values) {
  return {
    n: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
  };
}

export function countStatuses(results) {
  const counts = {};
  for (const result of results) counts[result.status] = (counts[result.status] ?? 0) + 1;
  return counts;
}

export function assertBulkheadStatuses(results, { protectedArm }) {
  for (const result of results) {
    assert(result.status === 201 || result.status === 503, `bulkhead unexpected HTTP ${result.status}`);
    if (result.status === 503) {
      assert(result.code === 'PAYMENT_UNAVAILABLE', `bulkhead unexpected code ${result.code ?? 'none'}`);
    }
  }
  const counts = countStatuses(results);
  if (protectedArm) {
    assert(counts[503] > 0, 'bulkhead protected arm had no bulkhead rejection');
    assert(counts[201] > 0, 'bulkhead protected arm had no confirmed sale');
  } else {
    assert(counts[201] === results.length, 'bulkhead unprotected arm had a non-201 result');
  }
  return counts;
}

export function assertCbStatuses(results) {
  for (const result of results) {
    assert(result.status === 503, `circuit breaker expected 503, got ${result.status}`);
    assert(result.code === 'PAYMENT_UNAVAILABLE', `circuit breaker unexpected code ${result.code ?? 'none'}`);
  }
  return countStatuses(results);
}

export function assertBulkheadResilience(snapshot, { protectedArm }) {
  assert(snapshot.circuit.enabled === false, 'bulkhead arm must have the circuit disabled');
  if (protectedArm) {
    assert(snapshot.bulkhead.enabled === true, 'bulkhead protected flag is off');
    assert(snapshot.bulkhead.maxConcurrent === BULKHEAD_CAP, 'bulkhead cap is not the published test cap');
    assert(snapshot.bulkhead.rejectedCalls > 0, 'bulkhead did not reject calls');
    assert(snapshot.bulkhead.peakInFlight > 0 && snapshot.bulkhead.peakInFlight <= BULKHEAD_CAP, 'bulkhead peak is outside the cap');
    assert(snapshot.bulkhead.inFlight === 0, 'bulkhead still has calls in flight');
  } else {
    assert(snapshot.bulkhead.enabled === false, 'bulkhead unprotected flag is on');
    assert(snapshot.bulkhead.rejectedCalls === 0, 'bulkhead unprotected rejected calls');
    assert(snapshot.bulkhead.peakInFlight === 0, 'bulkhead unprotected peak is not zero');
  }
}

export function assertCbResilience(snapshot, { protectedArm }) {
  assert(snapshot.bulkhead.enabled === false, 'circuit arm must have the bulkhead disabled');
  if (protectedArm) {
    assert(snapshot.circuit.enabled === true, 'circuit protected flag is off');
    assert(snapshot.circuit.openedCount > 0, 'circuit never opened');
    assert(snapshot.circuit.rejectedCalls > 0, 'circuit did not reject calls');
  } else {
    assert(snapshot.circuit.enabled === false, 'circuit unprotected flag is on');
    assert(snapshot.circuit.openedCount === 0, 'circuit opened without protection');
    assert(snapshot.circuit.rejectedCalls === 0, 'circuit rejected without protection');
  }
}

async function createCustomer(http, operator, tag) {
  const response = await http('/v1/customers', {
    method: 'POST',
    token: operator,
    body: { name: 'P4 continuity customer', email: `${tag}@example.invalid` },
  });
  if (response.status === 429) throw new Error('rate limit reached while creating customer');
  assert(response.status === 201, `customer expected 201, got ${response.status}`);
  const id = response.json?.id;
  assertUuid(id, 'continuity customer');
  return id;
}

async function postOrder(http, operator, customerId, partId, key) {
  const body = { customerId, items: [{ partId, quantity: 1 }] };
  const started = performance.now();
  let response;
  try {
    response = await http('/v1/orders', {
      method: 'POST',
      token: operator,
      headers: { 'Idempotency-Key': key },
      body,
    });
  } catch {
    return { status: null, code: null, key, body, token: operator, uncertain: true, durationMs: performance.now() - started };
  }
  const durationMs = Math.round((performance.now() - started) * 10) / 10;
  if (response.status === 429) throw new Error('rate limit reached while creating order');
  if (response.status === 201) {
    const orderId = response.json?.id;
    if (typeof orderId === 'string') {
      try {
        assertUuid(orderId, 'continuity order');
        return { status: 201, code: null, orderId, key, body, token: operator, uncertain: false, durationMs };
      } catch {
        return { status: 201, code: null, key, body, token: operator, uncertain: true, durationMs };
      }
    }
    return { status: 201, code: null, key, body, token: operator, uncertain: true, durationMs };
  }
  if (response.status === 503) {
    return { status: 503, code: response.json?.code, key, body, token: operator, uncertain: false, durationMs };
  }
  if (response.status === 500 || response.status === 504) {
    return { status: response.status, code: response.json?.code, key, body, token: operator, uncertain: true, durationMs };
  }
  throw new Error(`order unexpected HTTP ${response.status}`);
}

async function getCustomers(http, reader) {
  const started = performance.now();
  const response = await http('/v1/customers', { token: reader });
  const durationMs = Math.round((performance.now() - started) * 10) / 10;
  if (response.status === 429) throw new Error('rate limit reached while reading customers');
  assert(response.status === 200, `customers expected 200, got ${response.status}`);
  return { status: 200, durationMs };
}

export async function cleanupOrders(orders, {
  http,
  cancel = cancelOrder,
  log = () => {},
} = {}) {
  let pending = 0;
  for (const order of orders) {
    try {
      const result = await cancel({ orderId: order.orderId, token: order.token, request: http, warn: () => {} });
      if (!result.ok) {
        pending += 1;
        log(`[recovery] Idempotency-Key=${order.key}`);
      }
    } catch {
      pending += 1;
      log(`[recovery] Idempotency-Key=${order.key}`);
    }
  }
  return { total: orders.length, pending };
}

export async function recoverUncertainOrders(uncertain, {
  http,
  attempts = 3,
  delayMs = 500,
  sleepFn = sleep,
  log = () => {},
} = {}) {
  const orders = [];
  const unresolved = [];
  for (const item of uncertain) {
    let resolved = false;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await http('/v1/orders', {
          method: 'POST',
          token: item.token,
          headers: { 'Idempotency-Key': item.key },
          body: item.body,
        });
        if (response.status === 429) throw new Error('rate limit reached while recovering order');
        if (response.status === 201) {
          const orderId = response.json?.id;
          if (typeof orderId === 'string') {
            try {
              assertUuid(orderId, 'recovered continuity order');
              orders.push({ orderId, key: item.key, token: item.token });
              resolved = true;
              break;
            } catch {
              // Retry the same key; an invalid ID is not a cleanup handle.
            }
          }
        } else if (response.status === 503 && response.json?.code === 'PAYMENT_UNAVAILABLE') {
          resolved = true;
          break;
        } else if (response.status !== 500 && response.status !== 504) {
          break;
        }
      } catch {
        // Retry the same idempotency key under normal mode.
      }
      if (attempt + 1 < attempts) await sleepFn(delayMs);
    }
    if (!resolved) {
      unresolved.push(item);
      log(`[recovery] Idempotency-Key=${item.key}`);
    }
  }
  return { orders, unresolved };
}

function armDefinitions() {
  return [
    { name: 'bulkhead', protectedArm: true, partId: BULKHEAD_PART_ID, mode: 'slow', slowDelayMs: SLOW_DELAY_MS, flags: { circuitBreaker: false, bulkhead: true, maxConcurrent: BULKHEAD_CAP, timeoutMs: TIMEOUT_MS } },
    { name: 'bulkhead', protectedArm: false, partId: BULKHEAD_PART_ID, mode: 'slow', slowDelayMs: SLOW_DELAY_MS, flags: { circuitBreaker: false, bulkhead: false, maxConcurrent: BULKHEAD_CAP, timeoutMs: TIMEOUT_MS } },
    { name: 'circuit-breaker', protectedArm: true, partId: SEED_PART_ID, mode: 'down', flags: { circuitBreaker: true, bulkhead: false, maxConcurrent: BULKHEAD_CAP, timeoutMs: TIMEOUT_MS } },
    { name: 'circuit-breaker', protectedArm: false, partId: SEED_PART_ID, mode: 'down', flags: { circuitBreaker: false, bulkhead: false, maxConcurrent: BULKHEAD_CAP, timeoutMs: TIMEOUT_MS } },
  ];
}

function summarizeResults(posts, gets) {
  const postDurations = posts.map((result) => result.durationMs);
  const getDurations = gets.map((result) => result.durationMs);
  return {
    post: { statuses: countStatuses(posts), latency: summarizeLatencies(postDurations) },
    get: { statuses: countStatuses(gets), latency: summarizeLatencies(getDurations) },
    postDurations,
    getDurations,
  };
}

async function runRepetition(config, arm, rep, {
  http,
  run,
  stock,
  readSim = () => readSimulatorConfig(config, { run }),
  writeSim = (patch) => writeSimulatorConfig(config, patch, { run }),
  readResilience = () => readPaymentsResilience(config, { run }),
  recreate = (flags) => recreatePayments(config, flags, { run }),
  orders,
  uncertain,
  log,
}) {
  const tag = `p4-continuity-${arm.name}-${arm.protectedArm ? 'protected' : 'unprotected'}-${rep}-${randomUUID().slice(0, 8)}`;
  const operator = tokenFromCli('operator', `${tag}-operator`, { run });
  const reader = tokenFromCli('reader', `${tag}-reader`, { run });
  const stockBefore = await stock(arm.partId);
  await writeSim({ mode: 'normal' });
  const customerId = await createCustomer(http, operator, tag);
  await recreate(arm.flags);
  const warmKey = `${tag}-warmup`;
  const warm = await postOrder(http, operator, customerId, arm.partId, warmKey);
  if (warm.uncertain) {
    uncertain.push(warm);
    throw new Error('warmup order became uncertain');
  }
  assert(warm.status === 201, `warmup expected 201, got ${warm.status}`);
  orders.push({ orderId: warm.orderId, key: warm.key, token: warm.token });
  const warmCancel = await cleanupOrders([orders.at(-1)], { http, log });
  assert(warmCancel.pending === 0, 'warmup cancellation failed');

  const simBefore = await readSim();
  await writeSim(arm.mode === 'slow' ? { mode: 'slow', slowDelayMs: arm.slowDelayMs } : { mode: 'down' });
  const simArm = await readSim();
  assert(simArm.mode === arm.mode, `simulator mode is not ${arm.mode}`);
  if (arm.mode === 'slow') assert(simArm.slowDelayMs >= 600 && simArm.slowDelayMs <= 700, 'simulator slow delay is outside 600-700ms');

  const posts = [];
  const gets = [];
  if (arm.name === 'bulkhead') {
    const getPromise = getCustomers(http, reader);
    const postPromises = Array.from({ length: BULKHEAD_BURST }, (_, index) => (
      postOrder(http, operator, customerId, arm.partId, `${tag}-${index}`)
    ));
    const settled = await Promise.allSettled([getPromise, ...postPromises]);
    let measurementError;
    const getResult = settled[0];
    if (getResult.status === 'fulfilled') gets.push(getResult.value);
    else measurementError = getResult.reason;
    for (const result of settled.slice(1)) {
      if (result.status === 'rejected') {
        measurementError ??= result.reason;
        continue;
      }
      posts.push(result.value);
      if (result.value.status === 201 && result.value.orderId) {
        orders.push({ orderId: result.value.orderId, key: result.value.key, token: result.value.token });
      }
      if (result.value.uncertain) uncertain.push(result.value);
    }
    if (measurementError) throw measurementError;
    assertBulkheadStatuses(posts, { protectedArm: arm.protectedArm });
  } else {
    for (let index = 0; index < CB_ORDERS; index += 1) {
      const [getResult, postResult] = await Promise.allSettled([
        getCustomers(http, reader),
        postOrder(http, operator, customerId, arm.partId, `${tag}-${index}`),
      ]);
      let measurementError;
      if (postResult.status === 'fulfilled') {
        posts.push(postResult.value);
        if (postResult.value.status === 201 && postResult.value.orderId) {
          orders.push({ orderId: postResult.value.orderId, key: postResult.value.key, token: postResult.value.token });
        }
        if (postResult.value.uncertain) uncertain.push(postResult.value);
      } else {
        measurementError = postResult.reason;
      }
      if (getResult.status === 'fulfilled') gets.push(getResult.value);
      else measurementError ??= getResult.reason;
      if (measurementError) throw measurementError;
    }
    assertCbStatuses(posts);
  }

  const resilience = await readResilience();
  const simAfter = await readSim();
  assert(simBefore.mode === 'normal', 'simulator was not normal before the arm');
  assert(simAfter.mode === arm.mode, `simulator left ${arm.mode} mode during the arm`);
  if (arm.name === 'bulkhead') assertBulkheadResilience(resilience, { protectedArm: arm.protectedArm });
  else assertCbResilience(resilience, { protectedArm: arm.protectedArm });
  const rejectedWhileDownDelta = simAfter.stats.rejectedWhileDown - simBefore.stats.rejectedWhileDown;
  if (arm.name === 'circuit-breaker') {
    if (arm.protectedArm) {
      assert(rejectedWhileDownDelta > 0 && rejectedWhileDownDelta < CB_ORDERS, 'protected circuit did not reduce gateway calls');
    } else {
      assert(rejectedWhileDownDelta === CB_ORDERS, 'unprotected circuit did not reach the gateway for every order');
    }
  }

  await writeSim({ mode: 'normal' });
  const uncertainSeen = uncertain.length > 0;
  let recoveryPending = 0;
  if (uncertainSeen) {
    const recovered = await recoverUncertainOrders(uncertain, { http, log });
    orders.push(...recovered.orders);
    uncertain.length = 0;
    uncertain.push(...recovered.unresolved);
    recoveryPending = recovered.unresolved.length;
  }
  const cleanup = await cleanupOrders(orders, { http, log });
  const stockAfter = await stock(arm.partId);
  assert(stockAfter === stockBefore, `${arm.name} arm did not restore stock`);
  if (cleanup.pending > 0) throw new Error('confirmed order cleanup pending');
  if (recoveryPending > 0) throw new Error('uncertain order recovery unresolved');
  if (uncertainSeen) throw new Error('HTTP uncertain order invalidated the repetition');

  return {
    rep,
    ...summarizeResults(posts, gets),
    resilience,
    simulator: { mode: simArm.mode, rejectedWhileDownDelta },
    stockBefore,
    stockAfter,
  };
}

function aggregateReps(reps) {
  return {
    post: {
      statuses: reps.reduce((acc, rep) => {
        for (const [status, count] of Object.entries(rep.post.statuses)) acc[status] = (acc[status] ?? 0) + count;
        return acc;
      }, {}),
      latency: summarizeLatencies(reps.flatMap((rep) => rep.postDurations)),
    },
    get: {
      statuses: reps.reduce((acc, rep) => {
        for (const [status, count] of Object.entries(rep.get.statuses)) acc[status] = (acc[status] ?? 0) + count;
        return acc;
      }, {}),
      latency: summarizeLatencies(reps.flatMap((rep) => rep.getDurations)),
    },
  };
}

export async function runContinuity(config, {
  http = createHttpClient(config.baseUrl),
  run = composeRun(config),
  stock = (partId) => getPartStock(config, { partId, run }),
  log = (message) => process.stderr.write(`${message}\n`),
  deps = {},
} = {}) {
  const report = {
    status: 'failed',
    project: config.project,
    port: config.port,
    pagos: 'real-service+simulated-gateway',
    exclusive: 'dedicated project, serial; no smoke/load concurrently',
    host: { platform: platform(), release: release(), node: process.version, cpus: cpus().length, date: new Date().toISOString() },
    params: {
      timeoutMs: TIMEOUT_MS,
      bulkheadCap: BULKHEAD_CAP,
      slowDelayMs: SLOW_DELAY_MS,
      bulkheadBurst: BULKHEAD_BURST,
      circuitOrders: CB_ORDERS,
      repetitions: REPETITIONS,
      warmup: 'one normal-mode sale per repetition',
      latencySource: 'host HTTP around each request',
    },
    runtimeArgs: {
      paymentsRecreate: ['docker', 'compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.p4.yml', ...PAYMENTS_RECREATE_ARGS],
      simulator: 'docker compose exec -T payment-gateway-sim node --input-type=module -e <GET/PUT /admin/config>',
      resilience: 'docker compose exec -T payments-api node --input-type=module -e <GET /internal/v1/resilience>',
    },
    initial: null,
    arms: [],
    restore: { skipped: true },
    cleanup: { confirmedCancelled: 0, pending: 0, uncertainResolved: 0, uncertainPending: 0 },
  };
  const orders = [];
  const uncertain = [];
  let touched = false;
  let failure;
  let initial;
  try {
    await (deps.preflight ?? preflight)(config, { run });
    const actualSteps = readContainerEnv('sales-api', 'SAGA_STEPS', { run });
    assert(actualSteps === 'stock,payment,dispatch', `SAGA_STEPS is ${actualSteps}; expected stock,payment,dispatch`);
    const dispatchFail = readContainerEnv('dispatch-api', 'DISPATCH_FAIL_CREATE', { run });
    assert(dispatchFail === 'false', 'DISPATCH_FAIL_CREATE must be false');
    const flags = {
      circuitBreaker: readContainerEnv('payments-api', 'PAYMENTS_CIRCUIT_BREAKER_ENABLED', { run }),
      bulkhead: readContainerEnv('payments-api', 'PAYMENTS_BULKHEAD_ENABLED', { run }),
      maxConcurrent: readContainerEnv('payments-api', 'PAYMENTS_BULKHEAD_MAX_CONCURRENT', { run }),
      timeoutMs: readContainerEnv('payments-api', 'PAYMENTS_GATEWAY_TIMEOUT_MS', { run }),
    };
    assert(flags.circuitBreaker === 'true' && flags.bulkhead === 'true', 'payments protection flags are not normal');
    assert(flags.maxConcurrent === '8' && flags.timeoutMs === '1200', 'payments normal cap/timeout are not 8/1200');
    const simulator = readSimulatorConfig(config, { run });
    assert(simulator.mode === 'normal', `simulator mode is ${simulator.mode}; expected normal`);
    const resilience = readPaymentsResilience(config, { run });
    assert(resilience.gatewayTimeoutMs === TIMEOUT_MS, 'payments timeout is not 1200ms');
    initial = {
      sagaSteps: actualSteps,
      dispatchFailCreate: dispatchFail,
      simulator: { mode: simulator.mode, latencyMs: simulator.latencyMs, slowDelayMs: simulator.slowDelayMs },
      payments: { circuitBreaker: true, bulkhead: true, maxConcurrent: 8, timeoutMs: 1200 },
      stock: { bulkhead: await stock(BULKHEAD_PART_ID), seed: await stock(SEED_PART_ID) },
    };
    report.initial = initial;
    touched = true;
    for (const arm of armDefinitions()) {
      const reps = [];
      for (let rep = 1; rep <= REPETITIONS; rep += 1) {
        log(`[arm] ${arm.name} ${arm.protectedArm ? 'protected' : 'unprotected'} rep ${rep}/${REPETITIONS}`);
        reps.push(await runRepetition(config, arm, rep, {
          http, run, stock, orders, uncertain, log,
          ...(deps.repetition ?? {}),
        }));
      }
      report.arms.push({
        name: arm.name,
        protected: arm.protectedArm,
        flags: arm.flags,
        simulatorMode: arm.mode,
        repetitions: reps,
        aggregate: aggregateReps(reps),
      });
    }
  } catch (error) {
    failure = error;
  }

  let restore;
  try {
    restore = await (deps.restore ?? restoreAll)({
      config, initial, touched, orders, uncertain, http, run, stock, log,
    });
  } catch (error) {
    restore = {
      ok: false,
      reason: safeError(error).message,
      cleanup: report.cleanup,
    };
  }
  report.restore = restore;
  report.cleanup = restore.cleanup ?? report.cleanup;
  if (failure) report.error = safeError(failure);
  if (!restore.ok) report.restoreError = safeError(new Error(restore.reason ?? 'restore failed'));
  report.status = failure || !restore.ok ? 'failed' : 'passed';
  return report;
}

export async function restoreAll({
  config,
  initial,
  touched,
  orders,
  uncertain,
  http,
  run,
  stock,
  log = () => {},
}) {
  if (!touched || !initial) return { ok: true, skipped: true, cleanup: { confirmedCancelled: 0, pending: 0, uncertainResolved: 0, uncertainPending: 0 } };
  const errors = [];
  const cleanup = { confirmedCancelled: 0, pending: 0, uncertainResolved: 0, uncertainPending: 0 };
  try {
    writeSimulatorConfig(config, { mode: 'normal' }, { run });
  } catch {
    errors.push('simulator normal restore failed');
  }
  if (uncertain.length > 0) {
    try {
      const recovered = await recoverUncertainOrders(uncertain, { http, log });
      orders.push(...recovered.orders);
      cleanup.uncertainResolved = recovered.orders.length;
      cleanup.uncertainPending = recovered.unresolved.length;
      uncertain.length = 0;
    } catch {
      cleanup.uncertainPending = uncertain.length;
      errors.push('uncertain recovery failed');
    }
  }
  try {
    const result = await cleanupOrders(orders, { http, log });
    cleanup.confirmedCancelled = result.total - result.pending;
    cleanup.pending = result.pending;
  } catch {
    cleanup.pending = orders.length;
    errors.push('order cleanup failed');
  }
  try {
    await recreatePayments(config, initial.payments, { run });
  } catch {
    errors.push('payments flags/timeout restore failed');
  }
  try {
    writeSimulatorConfig(config, initial.simulator, { run });
    const simulator = readSimulatorConfig(config, { run });
    assert(simulator.mode === initial.simulator.mode, 'simulator mode restore mismatch');
    assert(simulator.latencyMs === initial.simulator.latencyMs, 'simulator latency restore mismatch');
    assert(simulator.slowDelayMs === initial.simulator.slowDelayMs, 'simulator slow delay restore mismatch');
    const resilience = readPaymentsResilience(config, { run });
    assert(resilience.gatewayTimeoutMs === initial.payments.timeoutMs, 'payments timeout restore mismatch');
    assert(resilience.circuit.enabled === initial.payments.circuitBreaker, 'payments circuit restore mismatch');
    assert(resilience.bulkhead.enabled === initial.payments.bulkhead, 'payments bulkhead restore mismatch');
    assert(resilience.bulkhead.maxConcurrent === initial.payments.maxConcurrent, 'payments cap restore mismatch');
  } catch {
    errors.push('configuration restore verification failed');
  }
  let stockAfter = { bulkhead: null, seed: null };
  try {
    stockAfter = {
      bulkhead: await stock(BULKHEAD_PART_ID),
      seed: await stock(SEED_PART_ID),
    };
  } catch {
    errors.push('final stock read failed');
  }
  const stockOk = stockAfter.bulkhead === initial.stock.bulkhead && stockAfter.seed === initial.stock.seed;
  if (!stockOk) errors.push('final stock differs from initial');
  if (cleanup.pending > 0 || cleanup.uncertainPending > 0) errors.push('cleanup pending');
  return {
    ok: errors.length === 0,
    reason: errors.join('; '),
    simulator: initial.simulator,
    payments: initial.payments,
    stock: { before: initial.stock, after: stockAfter, verified: stockOk },
    cleanup,
  };
}

function safeError(error) {
  const name = error instanceof Error ? error.name : 'UnknownError';
  const message = error instanceof Error ? error.message : 'unknown error';
  return { name, message: message.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>') };
}

export async function main({ argv = process.argv.slice(2), env = process.env, deps = {} } = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return { help: true };
  }
  const config = resolveConfig({ argv: [], env, deps });
  const report = await runContinuity(config, { deps });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.status !== 'passed') process.exitCode = 1;
  return report;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    const safe = safeError(error);
    process.stderr.write(`[fail] ${safe.message}\n`);
    process.exitCode = 1;
  }
}
