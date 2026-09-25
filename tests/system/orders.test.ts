import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cancelOrder,
  createCustomer,
  createOrder,
  expectError,
  expectStatus,
  newIdempotencyKey,
  operatorKey,
  readerKey,
  partStock,
  partUnknown,
  partWithStock,
  request,
} from './api.js';

// El stock no se puede leer por REST, asi que se verifica por comportamiento:
// si la pieza tiene N unidades, deben entrar exactamente N ordenes y la N+1
// debe rechazarse. Eso prueba el descuento sin mirar la base de Inventory.

describe('Ordenes: ciclo de stock', () => {
  let customerId: string;
  const creadas: string[] = [];

  beforeAll(async () => {
    if (!Number.isInteger(partStock) || partStock < 1 || partStock > 20) {
      throw new Error(
        `PART_STOCK=${partStock} no sirve para este escenario: debe ser un entero entre 1 y 20. ` +
          'PART_WITH_STOCK debe apuntar a la pieza de pruebas con stock bajo, no a la del experimento.'
      );
    }
    customerId = (await createCustomer()).id;
  });

  afterAll(async () => {
    // Devolver el stock consumido deja el stack como estaba, para poder
    // repetir la suite sin resembrar.
    for (const orderId of creadas) {
      await cancelOrder(orderId);
    }
  });

  it('agota el stock, rechaza la siguiente orden y repone al cancelar', async () => {
    for (let i = 1; i <= partStock; i++) {
      const response = await createOrder(customerId, partWithStock());
      expectStatus(response, 201, `orden ${i} de ${partStock} con stock disponible`);
      expect(response.body.status).toBe('CONFIRMED');
      creadas.push(response.body.id);
    }

    // Si el stock no se hubiera descontado, esta tambien pasaria.
    const sinStock = await createOrder(customerId, partWithStock());
    expectError(
      sinStock,
      409,
      'INSUFFICIENT_STOCK',
      `orden ${partStock + 1} cuando el stock ya esta agotado`
    );

    const cancelada = await cancelOrder(creadas[0]);
    expectStatus(cancelada, 200, 'cancelar la primera orden');
    expect(cancelada.body.status).toBe('CANCELLED');
    expect(cancelada.body.cancelledAt).toBeTruthy();

    // La cancelacion repuso exactamente una unidad: entra una orden mas...
    const repuesta = await createOrder(customerId, partWithStock());
    expectStatus(repuesta, 201, 'orden despues de la reposicion de stock');
    creadas.push(repuesta.body.id);

    // ...y sólo una.
    const deNuevoSinStock = await createOrder(customerId, partWithStock());
    expectError(
      deNuevoSinStock,
      409,
      'INSUFFICIENT_STOCK',
      'orden despues de consumir la unidad repuesta'
    );
  });

  it('cancelar dos veces no repone el stock dos veces', async () => {
    // creadas[0] ya quedo cancelada en la prueba anterior.
    const segunda = await cancelOrder(creadas[0]);
    expectStatus(segunda, 200, 'cancelar por segunda vez la misma orden');
    expect(segunda.body.status).toBe('CANCELLED');

    // Si la segunda cancelacion hubiera repuesto stock, esta orden pasaria.
    const response = await createOrder(customerId, partWithStock());
    expectError(
      response,
      409,
      'INSUFFICIENT_STOCK',
      'orden despues de una cancelacion repetida'
    );
  });
});


describe('Ordenes: consultas publicas', () => {
  let customerId: string;
  let orderId: string;

  beforeAll(async () => {
    customerId = (await createCustomer()).id;
    const created = await createOrder(customerId, partWithStock());
    expectStatus(created, 201, 'crear una orden para consultar');
    orderId = created.body.id;
  });

  afterAll(async () => {
    if (orderId) await cancelOrder(orderId);
  });

  it('obtiene una orden con sus snapshots por id', async () => {
    const response = await request('GET', `/v1/orders/${orderId}`, { apiKey: readerKey() });
    expectStatus(response, 200, 'consultar una orden por id');
    expect(response.body.id).toBe(orderId);
    expect(response.body.status).toBe('CONFIRMED');
    expect(response.body.items[0]).toMatchObject({ partId: partWithStock(), quantity: 1 });
    expect(typeof response.body.items[0].sku).toBe('string');
    expect(typeof response.body.items[0].name).toBe('string');
  });

  it('lista ordenes con paginacion y filtros', async () => {
    const porDefecto = await request('GET', '/v1/orders', { apiKey: readerKey() });
    expectStatus(porDefecto, 200, 'listar ordenes sin paginacion explicita');
    expect(porDefecto.body.page).toBe(1);
    expect(porDefecto.body.pageSize).toBe(20);

    const response = await request(
      'GET',
      `/v1/orders?page=1&pageSize=10&status=CONFIRMED&customerId=${customerId}`,
      { apiKey: readerKey() }
    );
    expectStatus(response, 200, 'listar ordenes de un cliente');
    expect(response.body.page).toBe(1);
    expect(response.body.pageSize).toBe(10);
    expect(response.body.items.some((item: { id: string }) => item.id === orderId)).toBe(true);
  });

  it('devuelve 404 al consultar una orden inexistente', async () => {
    const response = await request('GET', '/v1/orders/00000000-0000-4000-8000-0000000000cc', {
      apiKey: readerKey(),
    });
    expectError(response, 404, 'ORDER_NOT_FOUND', 'consultar una orden inexistente');
  });
});
describe('Ordenes: idempotencia', () => {
  let customerId: string;
  const creadas: string[] = [];

  beforeAll(async () => {
    customerId = (await createCustomer()).id;
  });

  afterAll(async () => {
    for (const orderId of creadas) {
      await cancelOrder(orderId);
    }
  });

  it('la misma key con el mismo payload no crea una segunda orden', async () => {
    const key = newIdempotencyKey();

    const primera = await createOrder(customerId, partWithStock(), 1, key);
    expectStatus(primera, 201, 'primera orden con Idempotency-Key');
    expect(primera.headers.get('location')).toContain(primera.body.id);
    expect(primera.headers.get('x-trace-id')).toMatch(/^[0-9a-f-]{36}$/i);
    expect(primera.headers.get('idempotency-replayed')).toBe('false');
    creadas.push(primera.body.id);

    const reintento = await createOrder(customerId, partWithStock(), 1, key);
    expectStatus(reintento, 201, 'reintento con la misma Idempotency-Key y el mismo payload');
    expect(reintento.headers.get('idempotency-replayed')).toBe('true');
    expect(reintento.body.id).toBe(primera.body.id);
  });

  it('la misma key con otro payload devuelve 409', async () => {
    const key = newIdempotencyKey();

    const primera = await createOrder(customerId, partWithStock(), 1, key);
    expectStatus(primera, 201, 'orden original con Idempotency-Key');
    creadas.push(primera.body.id);

    const distinta = await createOrder(customerId, partWithStock(), 2, key);
    expectError(
      distinta,
      409,
      'IDEMPOTENCY_KEY_CONFLICT',
      'reusar la Idempotency-Key con un payload distinto'
    );
  });
  it('serializa reintentos concurrentes con la misma key', async () => {
    const key = newIdempotencyKey();
    const [primera, segunda] = await Promise.all([
      createOrder(customerId, partWithStock(), 1, key),
      createOrder(customerId, partWithStock(), 1, key),
    ]);
    expectStatus(primera, 201, 'primera solicitud concurrente con Idempotency-Key');
    expectStatus(segunda, 201, 'segunda solicitud concurrente con Idempotency-Key');
    expect(segunda.body.id).toBe(primera.body.id);
    creadas.push(primera.body.id);

    const replay = await createOrder(customerId, partWithStock(), 1, key);
    expectStatus(replay, 201, 'reintento despues de completar las solicitudes concurrentes');
    expect(replay.body.id).toBe(primera.body.id);
    expect(replay.headers.get('idempotency-replayed')).toBe('true');
  });
});

describe('Ordenes: validacion y referencias', () => {
  // Ninguna de estas ordenes debe llegar a reservar stock.
  let customerId: string;

  beforeAll(async () => {
    customerId = (await createCustomer()).id;
  });

  it('rechaza una cantidad invalida con 400', async () => {
    const response = await createOrder(customerId, partWithStock(), 0);
    expectError(response, 400, 'VALIDATION_ERROR', 'orden con quantity=0');
  });

  it('requiere Idempotency-Key para crear ordenes', async () => {
    const response = await request('POST', '/v1/orders', {
      apiKey: operatorKey(),
      body: { customerId, items: [{ partId: partWithStock(), quantity: 1 }] },
    });
    expectError(response, 400, 'VALIDATION_ERROR', 'crear una orden sin Idempotency-Key');
  });

  it('rechaza ids de pieza repetidos en la misma orden con 400', async () => {
    const response = await request('POST', '/v1/orders', {
      apiKey: operatorKey(),
      idempotencyKey: newIdempotencyKey(),
      body: {
        customerId,
        items: [
          { partId: partWithStock(), quantity: 1 },
          { partId: partWithStock(), quantity: 1 },
        ],
      },
    });
    expectError(response, 400, 'VALIDATION_ERROR', 'orden con el mismo partId repetido');
  });

  it('rechaza un cliente inexistente con 404', async () => {
    const response = await createOrder(
      '00000000-0000-4000-8000-0000000000bb',
      partWithStock()
    );
    expectError(response, 404, 'CUSTOMER_NOT_FOUND', 'orden de un cliente inexistente');
  });

  it('rechaza una pieza inexistente con 422', async () => {
    const response = await createOrder(customerId, partUnknown);
    expectError(response, 422, 'PART_NOT_FOUND', 'orden con una pieza que no existe en Inventory');
  });

  it('devuelve 404 al cancelar una orden inexistente', async () => {
    const response = await cancelOrder('00000000-0000-4000-8000-0000000000cc');
    expectError(response, 404, 'ORDER_NOT_FOUND', 'cancelar una orden inexistente');
  });
});
