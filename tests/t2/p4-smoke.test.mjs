import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cancelDispatch,
  cancelOrder,
  cleanupArtifacts,
  main,
  resolveRateLimitConfig,
  runRateLimitCheck,
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
