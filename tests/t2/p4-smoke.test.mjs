import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PART_ID,
  assertLoopbackBaseUrl,
  assertStockSummary,
  assertSummary,
  cancelDispatch,
  cancelOrder,
  cleanupArtifacts,
  composeEnvironment,
  main,
  parseSagaSteps,
  readContainerEnv,
  resolveRateLimitConfig,
  resolveSmokeMode,
  runDocker,
  runRateLimitCheck,
  tokenFromCli,
  windowIndex,
} from './p4-smoke.mjs';

const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const SUMMARY_ID = '22222222-2222-4222-8222-222222222222';
const DISPATCH_ID = '33333333-3333-4333-8333-333333333333';

function warningCollector() {
  const warnings = [];
  return { warnings, warn: (message) => warnings.push(message) };
}

test('module import does not run the smoke main', () => {
  assert.equal(typeof main, 'function');
});

test('cancelOrder accepts only HTTP 200 with CANCELLED', async () => {
  const { warnings, warn } = warningCollector();
  const result = await cancelOrder({
    orderId: ORDER_ID,
    token: 'operator-token',
    request: async () => ({ status: 200, json: { status: 'CANCELLED' } }),
    warn,
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(warnings.length, 0);
});

test('cancelOrder rejects 200 CONFIRMED without claiming success', async () => {
  const { warnings, warn } = warningCollector();
  const result = await cancelOrder({
    orderId: ORDER_ID,
    token: 'operator-token',
    request: async () => ({ status: 200, json: { status: 'CONFIRMED' } }),
    warn,
  });
  assert.equal(result.ok, false);
  assert.match(warnings[0], new RegExp(ORDER_ID));
  assert.match(warnings[0], /CONFIRMED/);
  assert.doesNotMatch(warnings[0], /confirmed CANCELLED/);
});

test('cancelOrder rejects 503 and thrown requests', async () => {
  const first = warningCollector();
  const failed = await cancelOrder({
    orderId: ORDER_ID,
    token: 'operator-token',
    request: async () => ({ status: 503, json: { code: 'UPSTREAM_UNAVAILABLE' } }),
    warn: first.warn,
  });
  assert.equal(failed.ok, false);
  assert.match(first.warnings[0], new RegExp(ORDER_ID));
  assert.match(first.warnings[0], /HTTP 503/);

  const second = warningCollector();
  const thrown = await cancelOrder({
    orderId: ORDER_ID,
    token: 'operator-token',
    request: async () => {
      throw new Error('network down');
    },
    warn: second.warn,
  });
  assert.equal(thrown.ok, false);
  assert.match(second.warnings[0], new RegExp(ORDER_ID));
  assert.match(second.warnings[0], /Error/);
});

test('cancelOrder marks missing token and missing id safely', async () => {
  const { warnings, warn } = warningCollector();
  const noToken = await cancelOrder({ orderId: ORDER_ID, warn });
  assert.equal(noToken.ok, false);
  assert.match(warnings[0], new RegExp(ORDER_ID));
  assert.match(warnings[0], /no operator token/);

  const skipped = await cancelOrder({ warn });
  assert.deepEqual(skipped, { ok: true, skipped: true });
  assert.equal(warnings.length, 1);
});

test('cancelDispatch confirms the container exit and explicit HTTP deadline', () => {
  let args;
  const { warnings, warn } = warningCollector();
  const result = cancelDispatch({
    orderId: DISPATCH_ID,
    run: (nextArgs) => {
      args = nextArgs;
      return { status: 0 };
    },
    warn,
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(warnings.length, 0);
  assert.equal(args[0], 'exec');
  assert.match(args.at(-1), /AbortSignal\.timeout\(5000\)/);
});

test('cancelDispatch rejects non-zero exits and thrown runners', () => {
  const first = warningCollector();
  const failed = cancelDispatch({
    orderId: DISPATCH_ID,
    run: () => ({ status: 2 }),
    warn: first.warn,
  });
  assert.equal(failed.ok, false);
  assert.match(first.warnings[0], new RegExp(DISPATCH_ID));
  assert.match(first.warnings[0], /exit 2/);

  const second = warningCollector();
  const thrown = cancelDispatch({
    orderId: DISPATCH_ID,
    run: () => {
      throw new Error('docker missing');
    },
    warn: second.warn,
  });
  assert.equal(thrown.ok, false);
  assert.match(second.warnings[0], new RegExp(DISPATCH_ID));
  assert.match(second.warnings[0], /Error/);
});

test('cleanupArtifacts continues after one failure and reports pending work', async () => {
  const calls = [];
  const result = await cleanupArtifacts({
    orderId: ORDER_ID,
    summaryId: SUMMARY_ID,
    dispatchId: DISPATCH_ID,
    token: 'operator-token',
    cancelOrderFn: async ({ orderId }) => {
      calls.push(`order:${orderId}`);
      return orderId === ORDER_ID ? { ok: false } : { ok: true };
    },
    cancelDispatchFn: ({ orderId }) => {
      calls.push(`dispatch:${orderId}`);
      return { ok: false };
    },
  });
  assert.deepEqual(result, { pending: true, attempted: true });
  assert.deepEqual(calls, [
    `order:${ORDER_ID}`,
    `order:${SUMMARY_ID}`,
    `dispatch:${DISPATCH_ID}`,
  ]);
});

test('cleanupArtifacts reports no pending work when everything cancels', async () => {
  const result = await cleanupArtifacts({
    orderId: ORDER_ID,
    summaryId: SUMMARY_ID,
    dispatchId: DISPATCH_ID,
    token: 'operator-token',
    cancelOrderFn: async () => ({ ok: true }),
    cancelDispatchFn: () => ({ ok: true }),
  });
  assert.deepEqual(result, { pending: false, attempted: true });
});

test('rate limit defaults and bounds are explicit', () => {
  assert.deepEqual(resolveRateLimitConfig('', ''), { limit: 60, windowMs: 60_000 });
  assert.deepEqual(resolveRateLimitConfig('1000', '60000'), { limit: 1000, windowMs: 60_000 });
  assert.match(resolveRateLimitConfig('1001', '60000').skipReason, /1000/);
  assert.match(resolveRateLimitConfig('60', '4999').skipReason, /too short/);
  assert.throws(() => resolveRateLimitConfig('0', '60000'), /invalid configured maximum/);
});

test('windowIndex uses the fixed epoch window', () => {
  assert.equal(windowIndex(0, 1_000), 0);
  assert.equal(windowIndex(999, 1_000), 0);
  assert.equal(windowIndex(1_000, 1_000), 1);
});

test('rate limit passes with exactly limit 200s and one 429 in the same window', async () => {
  const statuses = [200, 200, 200, 429];
  let index = 0;
  const tokens = [];
  const result = await runRateLimitCheck({
    limit: 3,
    windowMs: 1_000,
    now: () => 1_000,
    makeToken: (round) => {
      tokens.push(round);
      return `token-${round}`;
    },
    request: async () => ({ status: statuses[index++] }),
  });
  assert.equal(result.rounds, 1);
  assert.equal(result.totalRequests, 4);
  assert.equal(result.lastResponse.status, 429);
  assert.match(result.reason, /exact quota/);
  assert.deepEqual(tokens, [1]);
});

test('rate limit fails when 200+1 never produces 429 without a window change', async () => {
  let requests = 0;
  const tokens = [];
  await assert.rejects(
    runRateLimitCheck({
      limit: 3,
      windowMs: 1_000,
      now: () => 1_000,
      makeToken: (round) => {
        tokens.push(round);
        return `token-${round}`;
      },
      request: async () => {
        requests += 1;
        return { status: 200 };
      },
    }),
    /same window/,
  );
  assert.equal(requests, 4);
  assert.deepEqual(tokens, [1]);
});

test('rate limit retries once with a fresh identity after a window crossing', async () => {
  let clock = 0;
  let calls = 0;
  const tokens = [];
  const logs = [];
  const result = await runRateLimitCheck({
    limit: 3,
    windowMs: 1_000,
    now: () => clock,
    makeToken: (round) => {
      tokens.push(round);
      return `token-${round}`;
    },
    request: async () => {
      calls += 1;
      clock += 600;
      if (calls <= 4) return { status: 200 };
      return { status: calls === 8 ? 429 : 200 };
    },
    log: (message) => logs.push(message),
  });
  assert.equal(result.rounds, 2);
  assert.equal(result.totalRequests, 8);
  assert.match(result.reason, /window-crossing retry/);
  assert.deepEqual(tokens, [1, 2]);
  assert.ok(logs.some((message) => message.includes('window crossed')));
});

test('rate limit fails after two window-crossing rounds', async () => {
  let clock = 0;
  const tokens = [];
  await assert.rejects(
    runRateLimitCheck({
      limit: 3,
      windowMs: 1_000,
      now: () => clock,
      makeToken: (round) => {
        tokens.push(round);
        return `token-${round}`;
      },
      request: async () => {
        clock += 600;
        return { status: 200 };
      },
    }),
    /both allowed rounds/,
  );
  assert.deepEqual(tokens, [1, 2]);
});

test('rate limit allows the maximum configured limit with a bounded budget', async () => {
  let calls = 0;
  const result = await runRateLimitCheck({
    limit: 1_000,
    windowMs: 60_000,
    now: () => 1_000,
    makeToken: () => 'token',
    request: async () => {
      calls += 1;
      return { status: calls <= 1_000 ? 200 : 429 };
    },
  });
  assert.equal(result.rounds, 1);
  assert.equal(result.totalRequests, 1_001);
});

test('rate limit allows 1000 with one crossing retry within the total budget', async () => {
  let clock = 0;
  let calls = 0;
  const result = await runRateLimitCheck({
    limit: 1_000,
    windowMs: 60_000,
    now: () => clock,
    makeToken: () => 'token',
    request: async () => {
      calls += 1;
      clock += 31_000;
      if (calls <= 1_001) return { status: 200 };
      return { status: calls === 2_002 ? 429 : 200 };
    },
  });
  assert.equal(result.rounds, 2);
  assert.equal(result.totalRequests, 2_002);
});

test('rate limit enforces the total request budget', async () => {
  let clock = 0;
  await assert.rejects(
    runRateLimitCheck({
      limit: 3,
      windowMs: 1_000,
      maxTotalRequests: 4,
      now: () => clock,
      makeToken: () => 'token',
      request: async () => {
        clock += 600;
        return { status: 200 };
      },
    }),
    /budget 4 exceeded/,
  );
});

test('default limit of 60 does not retry indiscriminately without a window change', async () => {
  let requests = 0;
  const tokens = [];
  const config = resolveRateLimitConfig('', '');
  await assert.rejects(
    runRateLimitCheck({
      limit: config.limit,
      windowMs: config.windowMs,
      now: () => 1_000,
      makeToken: (round) => {
        tokens.push(round);
        return `token-${round}`;
      },
      request: async () => {
        requests += 1;
        return { status: 200 };
      },
    }),
    /same window/,
  );
  assert.equal(requests, 61);
  assert.deepEqual(tokens, [1]);
});

test('parseSagaSteps normalizes and rejects malformed lists', () => {
  assert.equal(parseSagaSteps(' stock, dispatch '), 'stock,dispatch');
  assert.equal(parseSagaSteps('stock'), 'stock');
  assert.throws(() => parseSagaSteps('stock,,dispatch'), /empty step/);
  assert.throws(() => parseSagaSteps('stock,stock'), /duplicate/);
  assert.throws(() => parseSagaSteps(undefined), /missing/);
});

test('resolveSmokeMode accepts only stock and stock,dispatch and fails closed on payment', () => {
  assert.equal(resolveSmokeMode({ actual: 'stock' }), 'stock');
  assert.equal(resolveSmokeMode({ actual: ' stock, dispatch ' }), 'stock,dispatch');
  assert.equal(resolveSmokeMode({ actual: 'stock', expected: 'stock' }), 'stock');
  assert.throws(
    () => resolveSmokeMode({ actual: 'stock,payment,dispatch' }),
    /pendiente de integración P2/,
  );
  assert.throws(
    () => resolveSmokeMode({ actual: 'stock,dispatch', expected: 'full' }),
    /pendiente de integración P2/,
  );
  assert.throws(
    () => resolveSmokeMode({ actual: 'stock,dispatch', expected: 'stock' }),
    /no coincide/,
  );
  assert.throws(
    () => resolveSmokeMode({ actual: 'stock,refund' }),
    /no soportado/,
  );
});

test('assertLoopbackBaseUrl rejects remote or credential-bearing URLs', () => {
  assert.equal(assertLoopbackBaseUrl('http://127.0.0.1:8081'), 'http://127.0.0.1:8081');
  assert.equal(assertLoopbackBaseUrl('http://localhost:8080/'), 'http://localhost:8080');
  assert.throws(() => assertLoopbackBaseUrl('https://127.0.0.1:8081'), /http/);
  assert.throws(() => assertLoopbackBaseUrl('http://192.168.1.10:8081'), /127\.0\.0\.1 or localhost/);
  assert.throws(() => assertLoopbackBaseUrl('http://user:secret@127.0.0.1:8081'), /credentials/);
  assert.throws(() => assertLoopbackBaseUrl('http://127.0.0.1:8081/api'), /path/);
  assert.throws(() => assertLoopbackBaseUrl('http://127.0.0.1'), /explicit port/);
});

test('readContainerEnv fails closed on docker exec errors or an empty value', () => {
  let args;
  assert.equal(readContainerEnv('sales-api', 'SAGA_STEPS', {
    run: (nextArgs) => {
      args = nextArgs;
      return { status: 0, stdout: ' stock,dispatch\n' };
    },
  }), 'stock,dispatch');
  assert.equal(args[0], 'exec');
  assert.equal(args[2], 'sales-api');
  assert.throws(
    () => readContainerEnv('sales-api', 'SAGA_STEPS', {
      run: () => ({ error: new Error('docker missing'), status: null, stdout: '' }),
    }),
    /Error/,
  );
  assert.throws(
    () => readContainerEnv('sales-api', 'SAGA_STEPS', { run: () => ({ status: 1, stdout: '' }) }),
    /exit 1/,
  );
  assert.throws(
    () => readContainerEnv('sales-api', 'SAGA_STEPS', { run: () => ({ status: 0, stdout: '' }) }),
    /empty/,
  );
  assert.equal(readContainerEnv('api-gateway', 'GATEWAY_RATE_LIMIT_MAX_REQUESTS', {
    run: () => ({ status: 0, stdout: '' }),
    allowEmpty: true,
  }), '');
});

test('tokenFromCli fails closed and never accepts a malformed token', () => {
  assert.equal(tokenFromCli('reader', 'p4-reader', {
    run: () => ({ status: 0, stdout: 'a.b.c\n' }),
  }), 'a.b.c');
  assert.throws(
    () => tokenFromCli('reader', 'p4-reader', { run: () => ({ status: 1, stdout: '' }) }),
    /token CLI failed/,
  );
  assert.throws(
    () => tokenFromCli('reader', 'p4-reader', { run: () => ({ status: 0, stdout: 'not-a-jwt' }) }),
    /invalid token/,
  );
});

test('runDocker uses shell:false and the scoped Compose environment', () => {
  let captured;
  const result = runDocker(['ps'], 1_000, {
    spawn: (command, args, options) => {
      captured = { command, args, options };
      return { status: 0, stdout: 'ok', stderr: '' };
    },
    env: {
      COMPOSE_PROJECT_NAME: 'repuestossur-p4-test',
      COMPOSE_ENV_FILES: '/repo/.env.p4',
    },
  });
  assert.equal(result.status, 0);
  assert.equal(captured.command, 'docker');
  assert.deepEqual(captured.args.slice(0, 5), [
    'compose',
    '-f',
    'docker-compose.yml',
    '-f',
    'docker-compose.p4.yml',
  ]);
  assert.equal(captured.args.at(-1), 'ps');
  assert.equal(captured.options.shell, false);
  assert.equal(captured.options.env.COMPOSE_PROJECT_NAME, 'repuestossur-p4-test');
  assert.equal(captured.options.env.COMPOSE_ENV_FILES, '/repo/.env.p4');
});

test('composeEnvironment copies COMPOSE_PROJECT_NAME and COMPOSE_ENV_FILES without mutating', () => {
  const base = { COMPOSE_PROJECT_NAME: 'repuestossur-p4-independent', COMPOSE_ENV_FILES: '.env.p4' };
  const copy = composeEnvironment(base);
  assert.deepEqual(copy, base);
  assert.notEqual(copy, base);
  copy.COMPOSE_PROJECT_NAME = 'other';
  assert.equal(base.COMPOSE_PROJECT_NAME, 'repuestossur-p4-independent');
});

test('assertSummary accepts the two supported stock,dispatch summaries', () => {
  const orderId = '11111111-1111-4111-8111-111111111111';
  const items = [{ partId: PART_ID, quantity: 1 }];
  const created = {
    status: 200,
    text: '',
    json: {
      orderId,
      partial: true,
      payment: { availability: 'unavailable' },
      dispatch: { availability: 'available', data: { orderId, status: 'CREATED', items } },
    },
  };
  assert.doesNotThrow(() => assertSummary(created, {
    statuses: [200],
    partial: true,
    paymentAvailability: 'unavailable',
    dispatchAvailability: 'available',
    dispatchStatus: 'CREATED',
    orderId,
    items,
    forbidPaymentStatus: 'CHARGED',
  }));
  assert.throws(() => assertSummary({ ...created, json: { ...created.json, partial: false } }, {
    statuses: [200],
    partial: true,
  }), /partial/);
  assert.throws(() => assertSummary({ ...created, json: {
    ...created.json,
    payment: { availability: 'available', data: { status: 'CHARGED' } },
  } }, {
    statuses: [200],
    paymentAvailability: 'unavailable',
    forbidPaymentStatus: 'CHARGED',
  }), /payment unavailable/);
  assert.throws(() => assertSummary({ ...created, json: {
    ...created.json,
    dispatch: { availability: 'available', data: { orderId, status: 'CANCELLED', items } },
  } }, {
    statuses: [200],
    dispatchAvailability: 'available',
    dispatchStatus: 'CREATED',
    orderId,
    items,
  }), /dispatch status/);
});

test('assertSummary validates stock-mode source codes and rejects CHARGED', () => {
  const unavailable = {
    status: 503,
    text: '{"code":"UPSTREAM_UNAVAILABLE"}',
    json: {
      code: 'UPSTREAM_UNAVAILABLE',
      message: 'One or more summary sources are unavailable',
      traceId: '22222222-2222-4222-8222-222222222222',
      details: { sources: { payment: 'unavailable', dispatch: 'not_found' } },
    },
  };
  assert.doesNotThrow(() => assertSummary(unavailable, {
    statuses: [503],
    codes: ['UPSTREAM_UNAVAILABLE'],
    sources: { payment: 'unavailable', dispatch: 'not_found' },
    forbidPaymentStatus: 'CHARGED',
  }));
  assert.throws(() => assertSummary({ ...unavailable, json: {
    ...unavailable.json,
    details: { sources: { payment: 'not_found', dispatch: 'not_found' } },
  } }, {
    statuses: [503],
    codes: ['UPSTREAM_UNAVAILABLE'],
    sources: { payment: 'unavailable', dispatch: 'not_found' },
  }), /payment source/);
  assert.throws(() => assertSummary({ ...unavailable, status: 200, json: {
    orderId: '11111111-1111-4111-8111-111111111111',
    partial: true,
    payment: { availability: 'available', data: { status: 'CHARGED' } },
    dispatch: { availability: 'unavailable' },
  } }, {
    statuses: [200],
    partial: true,
    forbidPaymentStatus: 'CHARGED',
  }), /CHARGED/);
  assert.doesNotThrow(() => assertSummary({
    status: 404,
    text: '{"code":"SUMMARY_NOT_FOUND"}',
    json: { code: 'SUMMARY_NOT_FOUND', message: 'No summary sources found for this order', traceId: '33333333-3333-4333-8333-333333333333' },
  }, {
    statuses: [404],
    codes: ['SUMMARY_NOT_FOUND'],
    forbidPaymentStatus: 'CHARGED',
  }));
});

test('assertStockSummary accepts 503/404 and rejects other statuses or codes', () => {
  assert.doesNotThrow(() => assertStockSummary({
    status: 503,
    text: '{"code":"UPSTREAM_UNAVAILABLE"}',
    json: {
      code: 'UPSTREAM_UNAVAILABLE',
      message: 'One or more summary sources are unavailable',
      traceId: '22222222-2222-4222-8222-222222222222',
      details: { sources: { payment: 'unavailable', dispatch: 'not_found' } },
    },
  }, 'stock summary'));
  assert.doesNotThrow(() => assertStockSummary({
    status: 404,
    text: '{"code":"SUMMARY_NOT_FOUND"}',
    json: { code: 'SUMMARY_NOT_FOUND', message: 'No summary sources found for this order', traceId: '33333333-3333-4333-8333-333333333333' },
  }, 'stock summary'));
  assert.throws(() => assertStockSummary({
    status: 200,
    text: '{"partial":true}',
    json: { orderId: '11111111-1111-4111-8111-111111111111', partial: true },
  }, 'stock summary'), /expected 503 or 404/);
  assert.throws(() => assertStockSummary({
    status: 503,
    text: '{"code":"SUMMARY_NOT_FOUND"}',
    json: {
      code: 'SUMMARY_NOT_FOUND',
      message: 'No summary sources found for this order',
      traceId: '33333333-3333-4333-8333-333333333333',
      details: { sources: { payment: 'unavailable', dispatch: 'not_found' } },
    },
  }, 'stock summary'), /expected code/);
});
