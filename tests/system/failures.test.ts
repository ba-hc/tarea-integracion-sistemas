import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cancelOrder,
  createCustomer,
  createOrder,
  expectError,
  expectStatus,
  partWithStock,
} from './api.js';

// Estas pruebas detienen y ralentizan Inventory, asi que no son hermeticas:
// tocan el stack por fuera del contrato HTTP. Por eso quedan fuera de la
// corrida por defecto y se activan con RUN_FAILURE_TESTS=1.
//
// Requieren el perfil 'experiment' de Compose, porque el caso de dependencia
// lenta necesita Toxiproxy interpuesto entre Sales e Inventory.

const habilitadas = process.env.RUN_FAILURE_TESTS === '1';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const toxicScript = resolve(repoRoot, 'experiments/timeout/scripts/toxic.sh');

const inventoryService = process.env.INVENTORY_SERVICE ?? 'inventory-grpc';

// 1500 ms supera con holgura el deadline congelado de 800 ms.
const latenciaLenta = 1500;

const compose = (...args: string[]) =>
  execFileSync('docker', ['compose', ...args], { cwd: repoRoot, stdio: 'pipe' });

const toxic = (...args: string[]) =>
  execFileSync('bash', [toxicScript, ...args], { cwd: repoRoot, stdio: 'pipe' });

describe.skipIf(!habilitadas)('Fallas de la dependencia', () => {
  let customerId: string;

  beforeAll(async () => {
    customerId = (await createCustomer()).id;
  });

  afterAll(() => {
    // Dejar el stack sano aunque una prueba haya fallado a mitad de camino.
    try {
      toxic('clear');
    } catch {
      // Toxiproxy puede no estar levantado; no es motivo para ensuciar el reporte.
    }
    compose('start', inventoryService);
  });

  it('con Inventory detenido responde 503', async () => {
    compose('stop', inventoryService);
    try {
      const response = await createOrder(customerId, partWithStock());
      expectError(
        response,
        503,
        'INVENTORY_UNAVAILABLE',
        'crear una orden con Inventory detenido'
      );
    } finally {
      compose('start', inventoryService);
    }
  });

  it(`con Inventory mas lento que el deadline responde 504`, async () => {
    toxic('ensure');
    toxic('set', String(latenciaLenta));
    try {
      const inicio = Date.now();
      const response = await createOrder(customerId, partWithStock());
      const transcurrido = Date.now() - inicio;

      expectError(
        response,
        504,
        'INVENTORY_TIMEOUT',
        `crear una orden con Inventory retrasado ${latenciaLenta} ms`
      );
      // El deadline tiene que cortar antes que la latencia inyectada: si Sales
      // esperara hasta el final, el 504 no estaria protegiendo al llamador.
      expect(transcurrido).toBeLessThan(latenciaLenta);
    } finally {
      toxic('clear');
    }
  });

  it('vuelve a aceptar ordenes cuando Inventory se recupera', async () => {
    const response = await createOrder(customerId, partWithStock());
    expectStatus(response, 201, 'crear una orden con Inventory recuperado');
    expect(response.body.status).toBe('CONFIRMED');

    // Devolver el stock consumido.
    await cancelOrder(response.body.id);
  });
});
