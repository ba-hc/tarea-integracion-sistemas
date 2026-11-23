// Cross-service P4 aggregation test. It is deliberately offline:
// - Gateway and BFF run as built child processes from their dist output.
// - Payments and Dispatch are local HTTP doubles only.
// - No Sales, database, Docker or real payment/dispatch side effects are used.
// Build prerequisites before running:
//   (cd apps/api-gateway && npm run build)
//   (cd apps/web-bff && npm run build)
//   node --test tests/t2/p4-aggregation.test.mjs

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = process.cwd();
const GATEWAY_APP = resolve(ROOT, 'apps/api-gateway/dist/src/app.js');
const GATEWAY_CONFIG = resolve(ROOT, 'apps/api-gateway/dist/src/config/gateway-config.js');
const GATEWAY_CLI = resolve(ROOT, 'apps/api-gateway/dist/src/cli/token.js');
const BFF_APP = resolve(ROOT, 'apps/web-bff/dist/src/app.js');
const BFF_CONFIG = resolve(ROOT, 'apps/web-bff/dist/src/config/bff-config.js');

for (const [label, file] of [
  ['Gateway app', GATEWAY_APP],
  ['Gateway config', GATEWAY_CONFIG],
  ['Gateway CLI', GATEWAY_CLI],
  ['BFF app', BFF_APP],
  ['BFF config', BFF_CONFIG],
]) {
  assert.ok(existsSync(file), `missing ${label} at ${file}; build both P4 services before running this test`);
}

const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const PART_ID = '22222222-2222-4222-8222-222222222222';
const JWT_SECRET = `${randomUUID()}${randomUUID()}`;
const READER_INTERNAL_KEY = `reader-${randomUUID()}`;
const OPERATOR_INTERNAL_KEY = `operator-${randomUUID()}`;

let payment;
let dispatch;
let bffChild;
let gatewayChild;
let bffUrl;
let gatewayUrl;
let readerToken;
let operatorToken;

function jsonResponse(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function startStub(initialHandler) {
  let handler = initialHandler;
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const record = {
      method: request.method ?? '',
      url: request.url ?? '',
      headers: request.headers,
      body,
    };
    requests.push(record);
    try {
      await handler(record, response);
    } catch {
      if (!response.headersSent) {
        response.statusCode = 500;
        response.end('{}');
      } else {
        response.destroy();
      }
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    setHandler(nextHandler) {
      handler = nextHandler;
    },
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => (error ? rejectClose(error) : resolveClose()));
    }),
  };
}

function startChild(script, env) {
  return spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function waitForReady(child) {
  return new Promise((resolveReady, rejectReady) => {
    let output = '';
    const timer = setTimeout(() => {
      cleanup();
      rejectReady(new Error('child app did not become ready'));
    }, 10_000);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
    };
    const onData = (chunk) => {
      output += chunk.toString();
      const match = /READY (\d+)/.exec(output);
      if (match !== null) {
        cleanup();
        child.stdout.resume();
        child.stderr.resume();
        resolveReady(Number(match[1]));
      }
    };
    const onExit = (code) => {
      cleanup();
      rejectReady(new Error(`child app exited before ready (${code})`));
    };
    child.stdout.on('data', onData);
    child.on('exit', onExit);
  });
}

async function waitForHealth(url) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        await response.text();
        return;
      }
    } catch {
      // The child is still starting; retry with a bounded delay.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`health check did not become ready: ${url}`);
}

async function stopChild(child) {
  if (child === undefined || child === null || child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 2_000);
  await exited.catch(() => undefined);
  clearTimeout(timer);
}

function tokenFromCli(role, subject) {
  const result = spawnSync(process.execPath, [GATEWAY_CLI, '--sub', subject, '--role', role], {
    cwd: ROOT,
    env: {
      ...process.env,
      GATEWAY_JWT_SECRET: JWT_SECRET,
      GATEWAY_JWT_ISSUER: 'repuestossur-demo',
      GATEWAY_JWT_AUDIENCE: 'repuestossur-gateway',
    },
    encoding: 'utf8',
    timeout: 10_000,
    shell: false,
  });
  assert.equal(result.status, 0, `token CLI failed for ${role}`);
  const token = result.stdout.trim();
  assert.equal(token.split('.').length, 3, `token CLI returned invalid token for ${role}`);
  return token;
}

function defaultPayment(_request, response) {
  jsonResponse(response, 200, {
    orderId: ORDER_ID,
    status: 'PENDING',
    amountMinor: 999,
    currency: 'USD',
    secret: 'payment-secret',
  });
}

function defaultDispatch(_request, response) {
  jsonResponse(response, 200, {
    orderId: ORDER_ID,
    status: 'CREATED',
    items: [{ partId: PART_ID, quantity: 1, secret: 'dispatch-secret' }],
    secret: 'dispatch-secret',
  });
}

async function summaryRequest(token, headers = {}) {
  const requestHeaders = { ...headers };
  if (token !== undefined) requestHeaders.Authorization = `Bearer ${token}`;
  const response = await fetch(`${gatewayUrl}/web/v1/orders/${ORDER_ID}/summary`, {
    headers: requestHeaders,
    redirect: 'manual',
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, text, json };
}

function assertUuid(value, message) {
  assert.match(value ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, message);
}

before(async () => {
  payment = await startStub(defaultPayment);
  dispatch = await startStub(defaultDispatch);

  const bffScript = `
import { createBffApp } from ${JSON.stringify(pathToFileURL(BFF_APP).href)};
import { loadBffConfig } from ${JSON.stringify(pathToFileURL(BFF_CONFIG).href)};
const app = await createBffApp(loadBffConfig());
await app.listen(0, '127.0.0.1');
const address = app.getHttpServer().address();
process.stdout.write('READY ' + address.port + '\\n');
process.on('SIGTERM', async () => { await app.close(); process.exit(0); });
`;
  bffChild = startChild(bffScript, {
    BFF_HOST: '127.0.0.1',
    BFF_PORT: '3002',
    BFF_PAYMENTS_BASE_URL: payment.url,
    BFF_DISPATCH_BASE_URL: dispatch.url,
    BFF_SOURCE_TIMEOUT_MS: '200',
    BFF_MAX_RESPONSE_BODY_BYTES: '2097152',
  });
  bffUrl = `http://127.0.0.1:${await waitForReady(bffChild)}`;
  await waitForHealth(`${bffUrl}/health`);

  const gatewayScript = `
import { createGatewayApp } from ${JSON.stringify(pathToFileURL(GATEWAY_APP).href)};
import { loadGatewayConfig } from ${JSON.stringify(pathToFileURL(GATEWAY_CONFIG).href)};
const app = await createGatewayApp(loadGatewayConfig());
await app.listen(0, '127.0.0.1');
const address = app.getHttpServer().address();
process.stdout.write('READY ' + address.port + '\\n');
process.on('SIGTERM', async () => { await app.close(); process.exit(0); });
`;
  gatewayChild = startChild(gatewayScript, {
    GATEWAY_HOST: '127.0.0.1',
    GATEWAY_PORT: '8080',
    GATEWAY_SALES_BASE_URL: 'http://127.0.0.1:1',
    GATEWAY_BFF_BASE_URL: bffUrl,
    GATEWAY_JWT_SECRET: JWT_SECRET,
    GATEWAY_JWT_ISSUER: 'repuestossur-demo',
    GATEWAY_JWT_AUDIENCE: 'repuestossur-gateway',
    GATEWAY_SALES_API_KEY_READER: READER_INTERNAL_KEY,
    GATEWAY_SALES_API_KEY_OPERATOR: OPERATOR_INTERNAL_KEY,
    GATEWAY_SALES_TIMEOUT_MS: '1000',
    GATEWAY_BFF_TIMEOUT_MS: '1000',
    GATEWAY_RATE_LIMIT_WINDOW_MS: '60000',
    GATEWAY_RATE_LIMIT_MAX_REQUESTS: '1000',
    GATEWAY_RATE_LIMIT_MAX_IDENTITIES: '100',
    GATEWAY_MAX_REQUEST_BODY_BYTES: '1048576',
    GATEWAY_MAX_RESPONSE_BODY_BYTES: '2097152',
  });
  gatewayUrl = `http://127.0.0.1:${await waitForReady(gatewayChild)}`;
  await waitForHealth(`${gatewayUrl}/health`);

  readerToken = tokenFromCli('reader', 'aggregation-reader');
  operatorToken = tokenFromCli('operator', 'aggregation-operator');
});

beforeEach(() => {
  payment.requests.length = 0;
  dispatch.requests.length = 0;
  payment.setHandler(defaultPayment);
  dispatch.setHandler(defaultDispatch);
});

after(async () => {
  await stopChild(gatewayChild);
  await stopChild(bffChild);
  if (payment !== undefined) await payment.close();
  if (dispatch !== undefined) await dispatch.close();
});

test('401 without JWT does not call either source', async () => {
  const response = await summaryRequest(undefined);
  assert.equal(response.status, 401);
  assert.match(response.headers.get('www-authenticate') ?? '', /bearer/i);
  assert.equal(payment.requests.length, 0);
  assert.equal(dispatch.requests.length, 0);
});

test('reader POST is forbidden without calling either source', async () => {
  const response = await fetch(`${gatewayUrl}/v1/orders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${readerToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ customerId: ORDER_ID, items: [{ partId: PART_ID, quantity: 1 }] }),
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 403);
  assert.equal(payment.requests.length, 0);
  assert.equal(dispatch.requests.length, 0);
});

test('complete aggregation is 200 partial:false for PENDING and DECLINED without false success', async () => {
  const response = await summaryRequest(readerToken, {
    'X-API-Key': 'caller-key',
    Cookie: 'caller-cookie',
    'X-Trace-Id': 'caller-trace',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, {
    orderId: ORDER_ID,
    partial: false,
    payment: {
      availability: 'available',
      data: { orderId: ORDER_ID, status: 'PENDING' },
    },
    dispatch: {
      availability: 'available',
      data: {
        orderId: ORDER_ID,
        status: 'CREATED',
        items: [{ partId: PART_ID, quantity: 1 }],
      },
    },
  });
  assert.doesNotMatch(response.text, /amountMinor|currency|secret|CHARGED/);

  const trace = response.headers.get('x-trace-id');
  assertUuid(trace, 'response trace must be a UUID');
  assert.notEqual(trace, 'caller-trace');
  assert.equal(payment.requests.length, 1);
  assert.equal(dispatch.requests.length, 1);
  for (const source of [payment.requests[0], dispatch.requests[0]]) {
    assert.equal(source.headers.authorization, undefined);
    assert.equal(source.headers['x-api-key'], undefined);
    assert.equal(source.headers.cookie, undefined);
    assert.equal(source.headers['x-trace-id'], trace);
    assert.equal(source.headers.accept, 'application/json');
  }
  assert.equal(payment.requests[0].url, `/internal/v1/payments/${ORDER_ID}`);
  assert.equal(dispatch.requests[0].url, `/internal/v1/dispatches/${ORDER_ID}`);

  payment.setHandler((_request, response) => {
    jsonResponse(response, 200, {
      orderId: ORDER_ID,
      status: 'DECLINED',
      amountMinor: 999,
      currency: 'USD',
      secret: 'payment-secret',
    });
  });
  const declined = await summaryRequest(readerToken);
  assert.equal(declined.status, 200);
  assert.deepEqual(declined.json, {
    orderId: ORDER_ID,
    partial: false,
    payment: {
      availability: 'available',
      data: { orderId: ORDER_ID, status: 'DECLINED' },
    },
    dispatch: {
      availability: 'available',
      data: {
        orderId: ORDER_ID,
        status: 'CREATED',
        items: [{ partId: PART_ID, quantity: 1 }],
      },
    },
  });
  assert.doesNotMatch(declined.text, /amountMinor|currency|secret|CHARGED/);
});

test('partial results preserve not_found and unavailable independently', async () => {
  payment.setHandler((_request, response) => jsonResponse(response, 404, { code: 'NOT_FOUND' }));
  const missing = await summaryRequest(readerToken);
  assert.equal(missing.status, 200);
  assert.deepEqual(missing.json, {
    orderId: ORDER_ID,
    partial: true,
    payment: { availability: 'not_found' },
    dispatch: {
      availability: 'available',
      data: {
        orderId: ORDER_ID,
        status: 'CREATED',
        items: [{ partId: PART_ID, quantity: 1 }],
      },
    },
  });

  payment.setHandler((_request, response) => jsonResponse(response, 503, { code: 'PAYMENT_UNAVAILABLE' }));
  const unavailable = await summaryRequest(readerToken);
  assert.equal(unavailable.status, 200);
  assert.deepEqual(unavailable.json, {
    orderId: ORDER_ID,
    partial: true,
    payment: { availability: 'unavailable' },
    dispatch: {
      availability: 'available',
      data: {
        orderId: ORDER_ID,
        status: 'CREATED',
        items: [{ partId: PART_ID, quantity: 1 }],
      },
    },
  });
});

test('both not_found is 404 SUMMARY_NOT_FOUND without CHARGED', async () => {
  payment.setHandler((_request, response) => jsonResponse(response, 404, { code: 'NOT_FOUND' }));
  dispatch.setHandler((_request, response) => jsonResponse(response, 404, { code: 'NOT_FOUND' }));
  const response = await summaryRequest(readerToken);
  assert.equal(response.status, 404);
  assert.equal(response.json.code, 'SUMMARY_NOT_FOUND');
  assert.doesNotMatch(response.text, /CHARGED/);
});

test('unavailable source is 503 and local source timeout is 504', async () => {
  payment.setHandler((_request, response) => jsonResponse(response, 503, { code: 'PAYMENT_UNAVAILABLE' }));
  dispatch.setHandler((_request, response) => jsonResponse(response, 404, { code: 'NOT_FOUND' }));
  const unavailable = await summaryRequest(readerToken);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(unavailable.json.details, {
    sources: { payment: 'unavailable', dispatch: 'not_found' },
  });
  assert.doesNotMatch(unavailable.text, /CHARGED/);

  payment.requests.length = 0;
  dispatch.requests.length = 0;
  payment.setHandler((_request, response) => {
    setTimeout(() => {
      if (!response.destroyed) response.destroy();
    }, 500);
  });
  const timedOut = await summaryRequest(readerToken);
  assert.equal(timedOut.status, 504);
  assert.deepEqual(timedOut.json.details, {
    sources: { payment: 'timeout', dispatch: 'not_found' },
  });
  assert.equal(payment.requests.length, 1);
  assert.equal(dispatch.requests.length, 1);
});
