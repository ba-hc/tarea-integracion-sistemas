import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

const baseUrl = 'http://127.0.0.1:3001/internal/v1/dispatches';

async function request(orderId, { method = 'GET', action = '', payload } = {}) {
  const response = await fetch(`${baseUrl}/${orderId}${action}`, {
    method,
    headers: payload === undefined ? undefined : { 'content-type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: await response.json() };
}

function put(orderId, items) {
  return request(orderId, { method: 'PUT', payload: { items } });
}

function cancel(orderId) {
  return request(orderId, { method: 'POST', action: '/cancel' });
}

function assertError(response, status, code) {
  assert.equal(response.status, status, JSON.stringify(response.body));
  for (const field of ['code', 'message', 'traceId']) {
    assert.equal(typeof response.body[field], 'string', field);
    assert.ok(response.body[field].trim(), field);
  }
  if (code) assert.equal(response.body.code, code);
}

function assertDispatch(response, httpStatus, orderId, items, status = 'CREATED') {
  assert.equal(response.status, httpStatus, JSON.stringify(response.body));
  assert.equal(response.body.orderId, orderId);
  assert.equal(response.body.status, status);
  const byPart = (a, b) => a.partId.localeCompare(b.partId);
  assert.deepEqual(response.body.items.toSorted(byPart), items.toSorted(byPart));
}

if (process.env.DISPATCH_FAIL_CREATE === 'true') {
  test('el fallo inducido rechaza la creación antes de persistir', async () => {
    const orderId = randomUUID();
    const items = [{ partId: randomUUID(), quantity: 2 }];

    assertError(await put(orderId, items), 503, 'DISPATCH_CREATE_REJECTED');
    assertError(await request(orderId), 404, 'DISPATCH_NOT_FOUND');
  });
} else {
  test('crea, consulta y cancela un despacho con reintentos', async () => {
    const orderId = randomUUID();
    const items = [{ partId: randomUUID(), quantity: 2 }, { partId: randomUUID(), quantity: 1 }];

    assertError(await request(orderId), 404, 'DISPATCH_NOT_FOUND');
    assertError(await cancel(orderId), 404, 'DISPATCH_NOT_FOUND');
    assertDispatch(await put(orderId, items), 201, orderId, items);
    assertDispatch(await put(orderId, items.toReversed()), 200, orderId, items);
    assertDispatch(await request(orderId), 200, orderId, items);
    assertDispatch(await cancel(orderId), 200, orderId, items, 'CANCELLED');
    assertDispatch(await cancel(orderId), 200, orderId, items, 'CANCELLED');
    assertError(await put(orderId, items), 409, 'DISPATCH_CANCELLED');
    assertDispatch(await request(orderId), 200, orderId, items, 'CANCELLED');
  });

  test('solicitudes iguales en paralelo crean un solo despacho', async () => {
    const orderId = randomUUID();
    const items = [{ partId: randomUUID(), quantity: 2 }];
    const responses = await Promise.all(Array.from({ length: 8 }, () => put(orderId, items)));

    assert.deepEqual(responses.map(({ status }) => status).toSorted(), [200, 200, 200, 200, 200, 200, 200, 201]);
    for (const response of responses) assertDispatch(response, response.status, orderId, items);
    assertDispatch(await request(orderId), 200, orderId, items);
  });

  test('solicitudes distintas para la misma orden preservan el primer despacho', async () => {
    const orderId = randomUUID();
    const partId = randomUUID();
    const variants = [[{ partId, quantity: 1 }], [{ partId, quantity: 2 }]];
    const responses = await Promise.all(variants.map((items) => put(orderId, items)));

    assert.deepEqual(responses.map(({ status }) => status).toSorted(), [201, 409]);
    const created = responses.findIndex(({ status }) => status === 201);
    const rejected = responses.findIndex(({ status }) => status === 409);
    assertDispatch(responses[created], 201, orderId, variants[created]);
    assertError(responses[rejected], 409, 'DISPATCH_CONFLICT');
    assertDispatch(await request(orderId), 200, orderId, variants[created]);
  });

  test('rechaza datos inválidos y no crea el despacho', async () => {
    const orderId = randomUUID();
    const partId = randomUUID();
    const item = { partId, quantity: 1 };
    const invalidItems = [
      [],
      [item, item],
      [{ partId, quantity: 0 }],
      [{ partId, quantity: 1.5 }],
      [{ partId: 'invalid', quantity: 1 }],
    ];

    assertError(await put('invalid', [item]), 400, 'VALIDATION_ERROR');
    for (const items of invalidItems) {
      assertError(await put(orderId, items), 400, 'VALIDATION_ERROR');
    }
    assertError(await request(orderId), 404, 'DISPATCH_NOT_FOUND');
  });
}
