import { describe, it } from 'vitest';
import {
  expectError,
  expectStatus,
  operatorKey,
  readerKey,
  request,
  uniqueEmail,
} from './api.js';

// Contrato: docs/architecture/AUTH.md
// reader puede GET, operator puede GET y POST, /v1/health es publico.

describe('Autenticacion y autorizacion', () => {
  it('sin API key devuelve 401', async () => {
    const response = await request('GET', '/v1/customers');
    expectError(response, 401, 'UNAUTHORIZED', 'GET /v1/customers sin key');
  });

  it('con API key invalida devuelve 401', async () => {
    const response = await request('GET', '/v1/customers', { apiKey: 'key-que-no-existe' });
    expectError(response, 401, 'UNAUTHORIZED', 'GET /v1/customers con key invalida');
  });

  it('una key reader puede hacer GET', async () => {
    const response = await request('GET', '/v1/customers', { apiKey: readerKey() });
    expectStatus(response, 200, 'GET /v1/customers con key reader');
  });

  it('una key reader no puede hacer POST', async () => {
    const response = await request('POST', '/v1/customers', {
      apiKey: readerKey(),
      body: { name: 'Intento de reader', email: uniqueEmail() },
    });
    expectError(response, 403, 'FORBIDDEN', 'POST /v1/customers con key reader');
  });

  it('una key operator puede hacer POST', async () => {
    const response = await request('POST', '/v1/customers', {
      apiKey: operatorKey(),
      body: { name: 'Cliente de operator', email: uniqueEmail() },
    });
    expectStatus(response, 201, 'POST /v1/customers con key operator');
  });

  it('/v1/health es publico', async () => {
    const response = await request('GET', '/v1/health');
    expectStatus(response, 200, 'GET /v1/health sin key');
  });
});
