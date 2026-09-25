import { describe, expect, it } from 'vitest';
import {
  expectError,
  expectStatus,
  operatorKey,
  readerKey,
  request,
  uniqueEmail,
} from './api.js';

describe('Clientes', () => {
  it('crea un cliente y devuelve 201 con Location', async () => {
    const email = uniqueEmail();
    const response = await request('POST', '/v1/customers', {
      apiKey: operatorKey(),
      body: { name: 'Ana Perez', email },
    });

    expectStatus(response, 201, 'crear un cliente valido');
    expect(response.body.id).toBeTruthy();
    expect(response.body.email).toBe(email);
    // El contrato exige el header pero no fija si es ruta relativa o absoluta.
    expect(response.headers.get('location')).toContain(response.body.id);
    expect(response.headers.get('x-trace-id')).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('consulta un cliente por id', async () => {
    const creado = await request('POST', '/v1/customers', {
      apiKey: operatorKey(),
      body: { name: 'Bruno Diaz', email: uniqueEmail() },
    });
    expectStatus(creado, 201, 'crear el cliente a consultar');

    const response = await request('GET', `/v1/customers/${creado.body.id}`, {
      apiKey: readerKey(),
    });
    expectStatus(response, 200, 'consultar el cliente recien creado');
    expect(response.body.id).toBe(creado.body.id);
  });

  it('devuelve 404 al consultar un cliente inexistente', async () => {
    const response = await request('GET', '/v1/customers/00000000-0000-4000-8000-0000000000aa', {
      apiKey: readerKey(),
    });
    expectError(response, 404, 'CUSTOMER_NOT_FOUND', 'consultar un cliente inexistente');
  });

  it('rechaza un email duplicado con 409', async () => {
    const email = uniqueEmail();
    const primero = await request('POST', '/v1/customers', {
      apiKey: operatorKey(),
      body: { name: 'Carla Soto', email },
    });
    expectStatus(primero, 201, 'crear el primer cliente');

    const duplicado = await request('POST', '/v1/customers', {
      apiKey: operatorKey(),
      body: { name: 'Carla Soto otra vez', email: email.toUpperCase() },
    });
    // El email es unico sin distinguir mayusculas, segun SYSTEM-DESIGN.md.
    expectError(duplicado, 409, 'CUSTOMER_EMAIL_CONFLICT', 'crear un cliente con email duplicado');
  });

  it('lista con los valores de paginacion por defecto', async () => {
    const response = await request('GET', '/v1/customers', { apiKey: readerKey() });

    expectStatus(response, 200, 'listar clientes sin parametros');
    expect(response.body.page).toBe(1);
    expect(response.body.pageSize).toBe(20);
    expect(Array.isArray(response.body.items)).toBe(true);
    expect(response.body.items.length).toBeLessThanOrEqual(20);
  });

  it('respeta pageSize y rechaza uno mayor al maximo', async () => {
    const valido = await request('GET', '/v1/customers?page=1&pageSize=1', {
      apiKey: readerKey(),
    });
    expectStatus(valido, 200, 'listar clientes con pageSize=1');
    expect(valido.body.items.length).toBeLessThanOrEqual(1);

    // El maximo congelado es 100.
    const excedido = await request('GET', '/v1/customers?pageSize=101', { apiKey: readerKey() });
    expectError(excedido, 400, 'VALIDATION_ERROR', 'listar clientes con pageSize=101');
  });
});
