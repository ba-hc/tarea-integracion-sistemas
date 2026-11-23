import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertBulkheadResilience,
  assertBulkheadStatuses,
  assertCbResilience,
  assertCbStatuses,
  cleanupOrders,
  countStatuses,
  main,
  parseArgs,
  parseResilience,
  parseSimulatorConfig,
  percentile,
  readPaymentsResilience,
  readSimulatorConfig,
  recreatePayments,
  recoverUncertainOrders,
  restoreAll,
  summarizeLatencies,
  usage,
  validateSimulatorPatch,
  writeSimulatorConfig,
} from './p4-continuity.mjs';

const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_ID = '22222222-2222-4222-8222-222222222222';
const KEY = 'p4-continuity-test-key';
const SIM_CONFIG = {
  mode: 'normal',
  latencyMs: 20,
  slowDelayMs: 3000,
  stats: { chargesApproved: 2, refunds: 1, voids: 0, rejectedWhileDown: 3 },
};
const RESILIENCE = {
  gateway: { timeoutMs: 1200 },
  circuitBreaker: { enabled: true, state: 'OPEN', openedCount: 1, rejectedCalls: 3 },
  bulkhead: { enabled: true, maxConcurrent: 2, peakInFlight: 2, rejectedCalls: 4, inFlight: 0 },
};

test('module import does not run the continuity CLI', () => {
  assert.equal(typeof main, 'function');
  assert.equal(typeof restoreAll, 'function');
});

test('parseArgs accepts no arguments or --help only', () => {
  assert.deepEqual(parseArgs([]), { help: false });
  assert.deepEqual(parseArgs(['--help']), { help: true });
  assert.throws(() => parseArgs(['--url', 'http://remote']), /unknown argument/);
  assert.match(usage(), /payments-api/);
  assert.match(usage(), /no smoke, load or other project traffic/);
});

test('simulator config parsing validates mode, delays and counters', () => {
  assert.deepEqual(parseSimulatorConfig(JSON.stringify(SIM_CONFIG)), SIM_CONFIG);
  assert.throws(() => parseSimulatorConfig('not-json'), /not valid JSON/);
  assert.throws(() => parseSimulatorConfig(JSON.stringify({ ...SIM_CONFIG, mode: 'broken' })), /mode is invalid/);
  assert.throws(() => parseSimulatorConfig(JSON.stringify({ ...SIM_CONFIG, slowDelayMs: -1 })), /slowDelayMs is invalid/);
  assert.throws(() => parseSimulatorConfig(JSON.stringify({ ...SIM_CONFIG, stats: null })), /stats are missing/);
  assert.throws(() => parseSimulatorConfig(JSON.stringify({
    ...SIM_CONFIG,
    stats: { ...SIM_CONFIG.stats, rejectedWhileDown: -1 },
  })), /rejectedWhileDown is invalid/);
});

test('simulator patch validation bounds mode and delays', () => {
  assert.deepEqual(validateSimulatorPatch({ mode: 'slow', slowDelayMs: 650 }), { mode: 'slow', slowDelayMs: 650 });
  assert.throws(() => validateSimulatorPatch({}), /unsupported fields/);
  assert.throws(() => validateSimulatorPatch({ mode: 'broken' }), /mode is invalid/);
  assert.throws(() => validateSimulatorPatch({ slowDelayMs: 120_001 }), /slowDelayMs is invalid/);
  assert.throws(() => validateSimulatorPatch({ latencyMs: -1 }), /latencyMs is invalid/);
});

test('simulator and resilience probes use fixed routes and timeouts', () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args.at(-1).includes("method: 'PUT'")) return { status: 0, stdout: '{}' };
    if (args.includes('payment-gateway-sim')) return { status: 0, stdout: JSON.stringify(SIM_CONFIG) };
    return { status: 0, stdout: JSON.stringify(RESILIENCE) };
  };
  assert.deepEqual(readSimulatorConfig({}, { run }), SIM_CONFIG);
  assert.match(calls.at(-1).at(-1), /\/admin\/config/);
  assert.match(calls.at(-1).at(-1), /AbortSignal\.timeout\(2000\)/);
  const applied = writeSimulatorConfig({}, { mode: 'slow', slowDelayMs: 650 }, {
    run: (args) => {
      calls.push(args);
      if (args.at(-1).includes("method: 'PUT'")) return { status: 0, stdout: '{}' };
      return { status: 0, stdout: JSON.stringify({ ...SIM_CONFIG, mode: 'slow', slowDelayMs: 650 }) };
    },
  });
  assert.equal(applied.mode, 'slow');
  assert.equal(applied.slowDelayMs, 650);
  assert.match(calls.at(-2).at(-1), /method: 'PUT'/);
  assert.match(calls.at(-2).at(-1), /\/admin\/config/);
  const resilience = readPaymentsResilience({}, {
    run: () => ({ status: 0, stdout: JSON.stringify(RESILIENCE) }),
  });
  assert.equal(resilience.gatewayTimeoutMs, 1200);
  assert.equal(resilience.circuit.state, 'OPEN');
  assert.equal(resilience.bulkhead.maxConcurrent, 2);
  assert.throws(() => readPaymentsResilience({}, {
    run: () => ({ status: 1, stdout: '' }),
  }), /resilience read failed/);
});

test('resilience parsing rejects malformed counters', () => {
  assert.throws(() => parseResilience('{}'), /gateway timeout is invalid|circuit enabled is invalid/);
  assert.throws(() => parseResilience(JSON.stringify({
    ...RESILIENCE,
    circuitBreaker: { ...RESILIENCE.circuitBreaker, state: 'BROKEN' },
  })), /circuit state is invalid/);
  assert.throws(() => parseResilience(JSON.stringify({
    ...RESILIENCE,
    bulkhead: { ...RESILIENCE.bulkhead, rejectedCalls: -1 },
  })), /bulkhead rejectedCalls is invalid/);
});

test('recreatePayments scopes only payments-api and verifies flags/timeout', async () => {
  let captured;
  const snapshot = await recreatePayments({ composeEnv: { KEEP: '1' } }, {
    circuitBreaker: true,
    bulkhead: false,
    maxConcurrent: 2,
    timeoutMs: 1200,
  }, {
    runUp: async (_config, args, options) => {
      captured = { args, options };
      return { code: 0, timedOut: false };
    },
    readResilience: async () => ({
      gatewayTimeoutMs: 1200,
      circuit: { enabled: true, state: 'CLOSED', openedCount: 0, rejectedCalls: 0 },
      bulkhead: { enabled: false, maxConcurrent: 2, peakInFlight: 0, rejectedCalls: 0, inFlight: 0 },
    }),
  });
  assert.equal(snapshot.gatewayTimeoutMs, 1200);
  assert.ok(captured.args.includes('payments-api'));
  assert.ok(captured.args.includes('--no-build'));
  assert.ok(captured.args.includes('--force-recreate'));
  assert.ok(captured.args.includes('--no-deps'));
  assert.equal(captured.args.at(-1), 'payments-api');
  assert.ok(!captured.args.includes('payment-gateway-sim'));
  assert.equal(captured.options.env.PAYMENTS_CIRCUIT_BREAKER_ENABLED, 'true');
  assert.equal(captured.options.env.PAYMENTS_BULKHEAD_ENABLED, 'false');
  assert.equal(captured.options.env.PAYMENTS_BULKHEAD_MAX_CONCURRENT, '2');
  assert.equal(captured.options.env.PAYMENTS_GATEWAY_TIMEOUT_MS, '1200');
  assert.equal(captured.options.env.KEEP, '1');

  await assert.rejects(recreatePayments({ composeEnv: {} }, {
    circuitBreaker: true,
    bulkhead: false,
    maxConcurrent: 2,
    timeoutMs: 1200,
  }, {
    runUp: async () => ({ code: 0, timedOut: false }),
    readResilience: async () => ({
      gatewayTimeoutMs: 999,
      circuit: { enabled: true, state: 'CLOSED', openedCount: 0, rejectedCalls: 0 },
      bulkhead: { enabled: false, maxConcurrent: 2, peakInFlight: 0, rejectedCalls: 0, inFlight: 0 },
    }),
  }), /timeout was not applied/);
});

test('percentiles, latency summaries and status counts are explicit', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([10, 20, 30, 40], 50), 20);
  assert.equal(percentile([10, 20, 30, 40], 95), 40);
  assert.equal(percentile([10, 20, 30, 40], 99), 40);
  assert.deepEqual(summarizeLatencies([10, 20, 30, 40]), { n: 4, p50: 20, p95: 40, p99: 40 });
  assert.deepEqual(countStatuses([{ status: 201 }, { status: 503 }, { status: 503 }]), { 201: 1, 503: 2 });
});

test('bulkhead and circuit guards reject arms that do not measure the phenomenon', () => {
  const protectedBulkhead = [
    { status: 201 },
    { status: 503, code: 'PAYMENT_UNAVAILABLE' },
  ];
  assert.deepEqual(assertBulkheadStatuses(protectedBulkhead, { protectedArm: true }), { 201: 1, 503: 1 });
  assert.doesNotThrow(() => assertBulkheadStatuses([{ status: 201 }], { protectedArm: false }));
  assert.throws(() => assertBulkheadStatuses([{ status: 503, code: 'PAYMENT_UNAVAILABLE' }], { protectedArm: false }), /non-201/);
  assert.throws(() => assertBulkheadStatuses([{ status: 201 }], { protectedArm: true }), /no bulkhead rejection/);
  assert.deepEqual(assertCbStatuses([
    { status: 503, code: 'PAYMENT_UNAVAILABLE' },
    { status: 503, code: 'PAYMENT_UNAVAILABLE' },
  ]), { 503: 2 });
  assert.throws(() => assertCbStatuses([{ status: 201 }]), /expected 503/);

  assert.doesNotThrow(() => assertBulkheadResilience({
    circuit: { enabled: false },
    bulkhead: { enabled: true, maxConcurrent: 2, peakInFlight: 2, rejectedCalls: 4, inFlight: 0 },
  }, { protectedArm: true }));
  assert.throws(() => assertBulkheadResilience({
    circuit: { enabled: false },
    bulkhead: { enabled: true, maxConcurrent: 2, peakInFlight: 3, rejectedCalls: 4, inFlight: 0 },
  }, { protectedArm: true }), /peak is outside/);
  assert.doesNotThrow(() => assertBulkheadResilience({
    circuit: { enabled: false },
    bulkhead: { enabled: false, maxConcurrent: 2, peakInFlight: 0, rejectedCalls: 0, inFlight: 0 },
  }, { protectedArm: false }));
  assert.doesNotThrow(() => assertCbResilience({
    circuit: { enabled: true, state: 'OPEN', openedCount: 1, rejectedCalls: 2 },
    bulkhead: { enabled: false },
  }, { protectedArm: true }));
  assert.throws(() => assertCbResilience({
    circuit: { enabled: true, state: 'CLOSED', openedCount: 0, rejectedCalls: 0 },
    bulkhead: { enabled: false },
  }, { protectedArm: true }), /never opened/);
  assert.doesNotThrow(() => assertCbResilience({
    circuit: { enabled: false, state: 'CLOSED', openedCount: 0, rejectedCalls: 0 },
    bulkhead: { enabled: false },
  }, { protectedArm: false }));
});

test('cleanup cancels every known order and reports pending work without UUIDs', async () => {
  const logs = [];
  const cancelled = [];
  const result = await cleanupOrders([
    { orderId: ORDER_ID, key: KEY, token: 'operator-token' },
    { orderId: SECOND_ID, key: 'second-key', token: 'operator-token' },
  ], {
    http: async () => ({ status: 200 }),
    cancel: async ({ orderId }) => {
      cancelled.push(orderId);
      return { ok: orderId === ORDER_ID, reason: orderId === ORDER_ID ? undefined : 'http-503' };
    },
    log: (message) => logs.push(message),
  });
  assert.deepEqual(cancelled, [ORDER_ID, SECOND_ID]);
  assert.deepEqual(result, { total: 2, pending: 1 });
  assert.ok(logs.some((message) => message.includes('second-key')));
  assert.ok(logs.every((message) => !message.includes(SECOND_ID)));
});

test('uncertain recovery reuses the same key and distinguishes resolved failures', async () => {
  const calls = [];
  const logs = [];
  const item = {
    key: KEY,
    token: 'operator-token',
    body: { customerId: 'customer', items: [] },
  };
  const result = await recoverUncertainOrders([item, { ...item, key: 'second-key' }], {
    http: async (path, options) => {
      calls.push({ path, options });
      if (options.headers['Idempotency-Key'] === KEY) {
        return { status: 201, json: { id: ORDER_ID } };
      }
      return { status: 503, json: { code: 'PAYMENT_UNAVAILABLE' } };
    },
    log: (message) => logs.push(message),
  });
  assert.equal(calls[0].path, '/v1/orders');
  assert.equal(calls[0].options.headers['Idempotency-Key'], KEY);
  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].orderId, ORDER_ID);
  assert.equal(result.unresolved.length, 0);
  assert.equal(logs.length, 0);

  const unresolved = await recoverUncertainOrders([item], {
    http: async () => ({ status: 500, json: {} }),
    attempts: 2,
    delayMs: 1,
    sleepFn: async () => {},
    log: (message) => logs.push(message),
  });
  assert.equal(unresolved.orders.length, 0);
  assert.equal(unresolved.unresolved.length, 1);
  assert.ok(logs.some((message) => message.includes(KEY)));
});

test('restoreAll is a no-op when no mutation happened', async () => {
  const result = await restoreAll({
    config: {},
    initial: null,
    touched: false,
    orders: [],
    uncertain: [],
    http: async () => ({}),
    run: () => {},
    stock: async () => 5,
  });
  assert.deepEqual(result, {
    ok: true,
    skipped: true,
    cleanup: { confirmedCancelled: 0, pending: 0, uncertainResolved: 0, uncertainPending: 0 },
  });
});
