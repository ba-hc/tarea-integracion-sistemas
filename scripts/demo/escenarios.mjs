#!/usr/bin/env node
// Demo y evidencia de la T2 (encargo Unidad 3, Forma D) sobre el Compose raíz.
//
//   docker compose up --build -d --wait
//   node scripts/demo/escenarios.mjs exposicion     # Gateway: token, roles, rate limit, puertos
//   node scripts/demo/escenarios.mjs exito          # Escenario 1: venta completa
//   node scripts/demo/escenarios.mjs compensacion   # Escenario 2: falla Despacho -> reembolso -> liberar
//   node scripts/demo/escenarios.mjs cascada        # Escenario 3: pasarela lenta y caída, con y sin protección
//   node scripts/demo/escenarios.mjs todo           # los cuatro, en orden
//
// Todo el tráfico de negocio entra por el API Gateway (único puerto publicado).
// Para observar el interior (stock, estado del circuito, contadores de la
// pasarela, eventos de la Saga) el script usa `docker compose exec`, igual que
// lo haría un operador: no publica puertos internos.
//
// Cada escenario imprime lo que ocurre y deja un JSON con la evidencia en
// --out (por defecto evidencia/<fecha>). El script deja el stack como lo
// encontró: pasarela en `normal`, Despacho sin falla y Pagos con protecciones.

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const GATEWAY_URL = process.env.GATEWAY_URL
  ?? `http://127.0.0.1:${process.env.GATEWAY_PUBLISHED_PORT ?? '8080'}`;
// Bujía de iridio (stock semilla 200): pieza de la demo. No se usa la pieza de
// la suite black-box de la T1.
const PART_ID = process.env.DEMO_PART_ID ?? 'd6e1fd98-cb07-458f-aa12-6fe220b37604';
const HTTP_TIMEOUT_MS = 15_000;
const SETTLE_TIMEOUT_MS = Number(process.env.DEMO_SETTLE_TIMEOUT_MS ?? 180_000);

// Valores por defecto del docker-compose.yml para Pagos y la pasarela.
const PAYMENTS_DEFAULTS = {
  PAYMENTS_CIRCUIT_BREAKER_ENABLED: 'true',
  PAYMENTS_BULKHEAD_ENABLED: 'true',
  PAYMENTS_BULKHEAD_MAX_CONCURRENT: '8',
  PAYMENTS_GATEWAY_TIMEOUT_MS: '1200',
  PAYMENTS_CB_OPEN_MS: '5000',
};
const PASARELA_NORMAL = { mode: 'normal', latencyMs: 20, slowDelayMs: 3000 };

// Escenario 3: carga y fases.
const PEAK_SALES = Number(process.env.DEMO_PEAK_SALES ?? 24);
const PEAK_CLIENTS = 4;
const DOWN_SALES = Number(process.env.DEMO_DOWN_SALES ?? 10);
const PROBE_INTERVAL_MS = 250;
const SLOW_DELAY_MS = 3000;

// ---------------------------------------------------------------------------
// Utilidades

const COLORS = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (COLORS ? `\x1b[${code}m${text}\x1b[0m` : text);
const title = (text) => console.log(`\n${paint('1;36', `== ${text} ==`)}`);
const step = (text) => console.log(`${paint('33', '->')} ${text}`);
const ok = (text) => console.log(`${paint('32', '[ok]')} ${text}`);
const info = (text) => console.log(`   ${text}`);

class DemoError extends Error {}

function check(condition, message) {
  if (!condition) throw new DemoError(message);
  ok(message);
}

function compose(args, { env = {}, timeoutMs = 300_000, input } = {}) {
  const result = spawnSync('docker', ['compose', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: timeoutMs,
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new DemoError(`docker compose ${args[0]} falló: ${result.error.message}`);
  return result;
}

function composeOk(args, options) {
  const result = compose(args, options);
  if (result.status !== 0) {
    throw new DemoError(`docker compose ${args.join(' ')} terminó con ${result.status}: ${result.stderr.trim().slice(-400)}`);
  }
  return result.stdout;
}

/** Ejecuta un fetch dentro de un contenedor y devuelve el JSON de la respuesta. */
function fetchInside(service, url, { method = 'GET', body } = {}) {
  const script = `
const init = { method: ${JSON.stringify(method)}, signal: AbortSignal.timeout(5000) };
${body === undefined ? '' : `init.headers = { 'content-type': 'application/json' }; init.body = ${JSON.stringify(JSON.stringify(body))};`}
const response = await fetch(${JSON.stringify(url)}, init);
process.stdout.write(await response.text());
process.exit(response.ok ? 0 : 1);`;
  const stdout = composeOk(['exec', '-T', service, 'node', '--input-type=module', '-e', script], { timeoutMs: 20_000 });
  return JSON.parse(stdout);
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[index] * 10) / 10;
}

function latencyStats(samples) {
  const ms = samples.map((sample) => sample.ms);
  return { n: ms.length, p50: percentile(ms, 50), p95: percentile(ms, 95), p99: percentile(ms, 99), max: percentile(ms, 100) };
}

function countBy(samples, key) {
  const counts = {};
  for (const sample of samples) {
    const value = key(sample);
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

const statusKey = (sample) => (sample.code ? `${sample.status} ${sample.code}` : String(sample.status));

// ---------------------------------------------------------------------------
// Acceso al sistema

// Una conexión nueva por petición (agent: false): entre fases el script recrea
// contenedores y espera varios segundos, y una conexión keep-alive reutilizada
// que el Gateway ya cerró daría un falso error de red.
function http(method, path, { token, body, headers = {} } = {}) {
  const started = performance.now();
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve) => {
    const request = httpRequest(`${GATEWAY_URL}${path}`, {
      method,
      agent: false,
      timeout: HTTP_TIMEOUT_MS,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        ...headers,
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
        resolve({
          status: response.statusCode,
          body: parsed,
          code: parsed && typeof parsed === 'object' ? parsed.code : undefined,
          ms: performance.now() - started,
          retryAfter: response.headers['retry-after'] ?? null,
        });
      });
      response.on('error', () => resolve({ status: 0, body: null, code: 'NETWORK_ERROR', ms: performance.now() - started }));
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error('timeout'), { code: 'CLIENT_TIMEOUT' })));
    request.on('error', (error) => resolve({
      status: 0, body: null, code: error.code === 'CLIENT_TIMEOUT' ? 'CLIENT_TIMEOUT' : 'NETWORK_ERROR', detail: error.code, ms: performance.now() - started,
    }));
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

function token(sub, role) {
  const value = composeOk(['exec', '-T', 'api-gateway', 'node', 'dist/src/cli/token.js', '--sub', sub, '--role', role], { timeoutMs: 30_000 }).trim();
  if (value.split('.').length !== 3) throw new DemoError(`el CLI de tokens no devolvió un JWT para ${role}`);
  return value;
}

function stock(partId = PART_ID) {
  const script = `
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
const definition = protoLoader.loadSync('/repo/contracts/grpc/repuestossur/inventory/v1/inventory.proto',
  { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true });
const pkg = grpc.loadPackageDefinition(definition);
const client = new pkg.repuestossur.inventory.v1.InventoryService('127.0.0.1:50051', grpc.credentials.createInsecure());
client.getPart({ part_id: ${JSON.stringify(partId)} }, { deadline: Date.now() + 3000 }, (error, response) => {
  if (error) process.exit(2);
  process.stdout.write(String(response.part.stock_available), () => process.exit(0));
});`;
  const stdout = composeOk(['exec', '-T', 'inventory-grpc', 'node', '--input-type=module', '-e', script], { timeoutMs: 20_000 });
  return Number(stdout.trim());
}

const pasarela = () => fetchInside('payment-gateway-sim', 'http://127.0.0.1:3010/admin/config');
const setPasarela = (config) => fetchInside('payment-gateway-sim', 'http://127.0.0.1:3010/admin/config', { method: 'PUT', body: config });
const resiliencia = () => fetchInside('payments-api', 'http://127.0.0.1:3003/internal/v1/resilience');

function sql(query) {
  return composeOk(['exec', '-T', 'sales-db', 'psql', '-U', 'sales', '-d', 'sales', '-At', '-F', '|', '-c', query], { timeoutMs: 20_000 })
    .trim().split('\n').filter(Boolean).map((line) => line.split('|'));
}

const safeKey = (key) => {
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(key)) throw new DemoError('Idempotency-Key inválida');
  return key;
};

/** Estado de la Saga y su bitácora persistida en la base de Ventas. */
function saga(idempotencyKey) {
  const key = safeKey(idempotencyKey);
  const [row] = sql(`SELECT order_id, status, stock_status, payment_status, dispatch_status, coalesce(failure_code, '') FROM sale_sagas WHERE idempotency_key = '${key}'`);
  if (!row) return null;
  const events = sql(`SELECT e.step, e.action, e.outcome, coalesce(e.code, ''), to_char(e.created_at AT TIME ZONE 'UTC', 'HH24:MI:SS.MS')
    FROM sale_saga_events e WHERE e.order_id = '${row[0]}' ORDER BY e.id`)
    .map(([stepName, action, outcome, code, at]) => ({ step: stepName, action, outcome, code: code || undefined, at }));
  return {
    orderId: row[0], status: row[1],
    steps: { stock: row[2], payment: row[3], dispatch: row[4] },
    failureCode: row[5] || undefined,
    events,
  };
}

function sagaStatuses(keys) {
  if (keys.length === 0) return {};
  const list = keys.map((key) => `'${safeKey(key)}'`).join(',');
  return Object.fromEntries(sql(`SELECT status, count(*) FROM sale_sagas WHERE idempotency_key IN (${list}) GROUP BY status`).map(([status, n]) => [status, Number(n)]));
}

/** Espera a que todas las Sagas de un lote lleguen a un estado terminal. */
async function settle(keys, label) {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let statuses = sagaStatuses(keys);
  while (Date.now() < deadline) {
    statuses = sagaStatuses(keys);
    const open = (statuses.RUNNING ?? 0) + (statuses.COMPENSATING ?? 0) + (statuses.CANCELLING ?? 0);
    if (open === 0) break;
    await sleep(1000);
  }
  info(`${label}: Sagas ${JSON.stringify(statuses)}`);
  return statuses;
}

function recreate(service, env) {
  composeOk(['up', '-d', '--wait', '--no-deps', '--force-recreate', service], { env, timeoutMs: 180_000 });
}

function containerEnv(service, name) {
  return composeOk(['exec', '-T', service, 'node', '-e', `process.stdout.write(process.env.${name} ?? '')`], { timeoutMs: 20_000 }).trim();
}

async function newCustomer(operator, label) {
  const response = await http('POST', '/v1/customers', {
    token: operator,
    body: { name: `Cliente demo ${label}`, email: `demo-${label}-${randomUUID().slice(0, 8)}@example.com` },
  });
  if (response.status !== 201) throw new DemoError(`no se pudo crear el cliente (${response.status} ${response.code ?? ''})`);
  return response.body.id;
}

function sell(operator, customerId, key, quantity = 1) {
  return http('POST', '/v1/orders', {
    token: operator,
    headers: { 'idempotency-key': key },
    body: { customerId, items: [{ partId: PART_ID, quantity }] },
  });
}

function logsSince(services, since, pattern) {
  const stdout = composeOk(['logs', '--no-color', '--since', since, ...services], { timeoutMs: 60_000 });
  return stdout.split('\n').filter((line) => pattern.test(line)).slice(-200);
}

// ---------------------------------------------------------------------------
// Escenarios

async function exposicion() {
  title('Exposición: API Gateway como único punto de entrada');
  const evidence = {};

  step('Puertos publicados por el stack (docker compose ps)');
  const ps = composeOk(['ps', '--format', 'json']).trim();
  const entries = ps.startsWith('[') ? JSON.parse(ps) : ps.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const published = entries
    .map((entry) => ({ service: entry.Service, ports: (entry.Publishers ?? []).filter((p) => p.PublishedPort > 0).map((p) => `${p.URL}:${p.PublishedPort}->${p.TargetPort}`) }))
    .filter((entry) => entry.ports.length > 0);
  for (const entry of published) info(`${entry.service}: ${entry.ports.join(', ')}`);
  evidence.services = entries.map((entry) => entry.Service).sort();
  evidence.published = published;
  check(published.length === 1 && published[0].service === 'api-gateway', 'sólo api-gateway publica un puerto en el host');

  step('Sin token');
  const anonymous = await http('GET', '/v1/customers');
  check(anonymous.status === 401, `GET /v1/customers sin token -> ${anonymous.status} ${anonymous.code ?? ''}`);

  step('Token reader intentando escribir');
  const reader = token(`demo-reader-${Date.now()}`, 'reader');
  const forbidden = await http('POST', '/v1/customers', { token: reader, body: { name: 'x', email: 'x@example.com' } });
  check(forbidden.status === 403, `POST /v1/customers con rol reader -> ${forbidden.status} ${forbidden.code ?? ''}`);

  step('Rate limiting por cliente: 70 GET seguidos con el mismo token');
  const flood = token(`demo-flood-${Date.now()}`, 'reader');
  const results = [];
  for (let i = 0; i < 70; i += 1) results.push(await http('GET', '/v1/customers?pageSize=1', { token: flood }));
  const counts = countBy(results, statusKey);
  const firstLimited = results.findIndex((result) => result.status === 429);
  info(`respuestas: ${JSON.stringify(counts)}; primera 429 en la petición #${firstLimited + 1}, Retry-After=${results[firstLimited]?.retryAfter ?? '-'} s`);
  check(firstLimited > 0 && results.slice(0, firstLimited).every((result) => result.status === 200), 'el Gateway corta con 429 RATE_LIMIT_EXCEEDED al superar la cuota');
  const other = await http('GET', '/v1/customers?pageSize=1', { token: reader });
  check(other.status === 200, `otro cliente sigue atendido mientras el primero está limitado -> ${other.status}`);
  evidence.auth = { anonymous: anonymous.status, readerPost: forbidden.status };
  evidence.rateLimit = { requests: results.length, counts, firstLimitedAt: firstLimited + 1, retryAfterSeconds: Number(results[firstLimited]?.retryAfter), otherClientStatus: other.status };
  return evidence;
}

async function exito() {
  title('Escenario 1 — Éxito: vender un repuesto (reservar -> cobrar -> despachar)');
  const operator = token(`demo-operador-${Date.now()}`, 'operator');
  const reader = token(`demo-lector-${Date.now()}`, 'reader');
  const customerId = await newCustomer(operator, 'exito');
  const stockBefore = stock();
  const pasarelaBefore = (await pasarela()).stats;
  info(`stock antes: ${stockBefore}; cobros aprobados en la pasarela: ${pasarelaBefore.chargesApproved}`);

  const key = `demo-exito-${randomUUID()}`;
  step(`POST /v1/orders (Idempotency-Key ${key.slice(0, 20)}…)`);
  const sale = await sell(operator, customerId, key);
  check(sale.status === 201 && sale.body.status === 'CONFIRMED', `venta -> ${sale.status} ${sale.body?.status ?? sale.code} en ${Math.round(sale.ms)} ms`);
  const orderId = sale.body.id;

  step('El cliente reintenta con la misma Idempotency-Key');
  const replay = await sell(operator, customerId, key);
  check(replay.status === 201 && replay.body.id === orderId, `reintento -> ${replay.status}, misma orden ${orderId.slice(0, 8)}…`);
  const conflict = await sell(operator, customerId, key, 2);
  check(conflict.status === 409, `misma key con otra cantidad -> ${conflict.status} ${conflict.code}`);

  step('BFF web: resumen de la venta (Pagos + Despacho en una respuesta)');
  const summary = await http('GET', `/web/v1/orders/${orderId}/summary`, { token: reader });
  info(JSON.stringify(summary.body));
  check(summary.status === 200 && summary.body.partial === false
    && summary.body.payment?.data?.status === 'CHARGED' && summary.body.dispatch?.data?.status === 'CREATED',
  'resumen 200: pago CHARGED y despacho CREATED');

  const stockAfter = stock();
  const pasarelaAfter = (await pasarela()).stats;
  const sagaState = saga(key);
  info(`bitácora de la Saga: ${sagaState.events.map((e) => `${e.step}:${e.action}:${e.outcome}`).join(' -> ')}`);
  check(sagaState.status === 'COMPLETED' && Object.values(sagaState.steps).every((s) => s === 'DONE'), 'Saga COMPLETED con los tres pasos DONE');
  check(stockBefore - stockAfter === 1, `stock ${stockBefore} -> ${stockAfter}: una sola reserva pese al reintento`);
  check(pasarelaAfter.chargesApproved - pasarelaBefore.chargesApproved === 1, 'la pasarela registró un solo cobro (sin doble cobro)');

  return {
    orderId, idempotencyKey: key,
    sale: { status: sale.status, orderStatus: sale.body.status, ms: Math.round(sale.ms) },
    replay: { status: replay.status, sameOrder: replay.body.id === orderId }, conflict: { status: conflict.status, code: conflict.code },
    summary: summary.body,
    saga: sagaState,
    stock: { before: stockBefore, after: stockAfter },
    pasarela: { chargesApprovedDelta: pasarelaAfter.chargesApproved - pasarelaBefore.chargesApproved, refundsDelta: pasarelaAfter.refunds - pasarelaBefore.refunds },
  };
}

async function compensacion() {
  title('Escenario 2 — Falla el último paso (Despacho): compensación en orden inverso');
  const operator = token(`demo-operador-comp-${Date.now()}`, 'operator');
  const reader = token(`demo-lector-comp-${Date.now()}`, 'reader');
  const customerId = await newCustomer(operator, 'compensacion');

  step('Se provoca la falla: Despacho rechaza toda creación (DISPATCH_FAIL_CREATE=true)');
  recreate('dispatch-api', { DISPATCH_FAIL_CREATE: 'true' });
  check(containerEnv('dispatch-api', 'DISPATCH_FAIL_CREATE') === 'true', 'dispatch-api recreado con la falla activa');

  try {
    const stockBefore = stock();
    const pasarelaBefore = (await pasarela()).stats;
    info(`stock antes: ${stockBefore}; pasarela cobros=${pasarelaBefore.chargesApproved} reembolsos=${pasarelaBefore.refunds}`);

    const key = `demo-comp-${randomUUID()}`;
    step('POST /v1/orders');
    const sale = await sell(operator, customerId, key);
    info(JSON.stringify(sale.body));
    check(sale.status === 503 && sale.code === 'DISPATCH_UNAVAILABLE', `venta -> ${sale.status} ${sale.code} en ${Math.round(sale.ms)} ms`);

    const statuses = await settle([key], 'tras la falla');
    const sagaState = saga(key);
    info('bitácora de la Saga (base de Ventas):');
    for (const event of sagaState.events) info(`  ${event.at}  ${event.step.padEnd(8)} ${event.action.padEnd(10)} ${event.outcome}${event.code ? ` (${event.code})` : ''}`);
    const executed = sagaState.events.filter((e) => e.action === 'EXECUTE' && e.outcome === 'DONE').map((e) => e.step);
    const compensated = sagaState.events.filter((e) => e.action === 'COMPENSATE' && e.outcome === 'COMPENSATED').map((e) => e.step);
    check(executed.join(',') === 'stock,payment', `pasos confirmados antes de la falla: ${executed.join(' -> ')}`);
    const reverse = compensated.filter((s) => s !== 'dispatch');
    check(reverse.join(',') === 'payment,stock', `compensación en orden inverso: ${compensated.join(' -> ')} (reembolsar y luego liberar)`);
    check(sagaState.status === 'FAILED' && sagaState.steps.stock === 'COMPENSATED' && sagaState.steps.payment === 'COMPENSATED', `Saga ${sagaState.status}: stock ${sagaState.steps.stock}, pago ${sagaState.steps.payment}, despacho ${sagaState.steps.dispatch}`);

    step('Reintento del cliente con la misma key: mismo resultado, sin efectos nuevos');
    const replay = await sell(operator, customerId, key);
    check(replay.status === 503 && replay.code === 'DISPATCH_UNAVAILABLE', `reintento -> ${replay.status} ${replay.code}`);

    const stockAfter = stock();
    const pasarelaAfter = (await pasarela()).stats;
    const summary = await http('GET', `/web/v1/orders/${sagaState.orderId}/summary`, { token: reader });
    const publicOrder = await http('GET', `/v1/orders/${sagaState.orderId}`, { token: reader });
    info(`resumen BFF: ${JSON.stringify(summary.body)}`);
    check(stockAfter === stockBefore, `stock ${stockBefore} -> ${stockAfter}: reserva liberada`);
    check(pasarelaAfter.chargesApproved - pasarelaBefore.chargesApproved === 1 && pasarelaAfter.refunds - pasarelaBefore.refunds === 1,
      'pasarela: 1 cobro y 1 reembolso (no queda cobro sin venta); el reintento no agregó efectos');
    check(summary.body?.payment?.data?.status === 'REFUNDED', `Pagos registra el cobro como ${summary.body?.payment?.data?.status}`);
    check(publicOrder.status === 404, `no existe orden pública para la venta fallida (GET /v1/orders/{id} -> ${publicOrder.status})`);

    return {
      idempotencyKey: key, orderId: sagaState.orderId,
      sale: { status: sale.status, code: sale.code, ms: Math.round(sale.ms) },
      replay: { status: replay.status, code: replay.code },
      saga: sagaState, sagaStatuses: statuses,
      stock: { before: stockBefore, after: stockAfter },
      pasarela: {
        chargesApprovedDelta: pasarelaAfter.chargesApproved - pasarelaBefore.chargesApproved,
        refundsDelta: pasarelaAfter.refunds - pasarelaBefore.refunds,
      },
      summary: summary.body,
      publicOrderStatus: publicOrder.status,
    };
  } finally {
    step('Se restaura Despacho (DISPATCH_FAIL_CREATE=false)');
    recreate('dispatch-api', { DISPATCH_FAIL_CREATE: 'false' });
  }
}

/** Sonda de «otras operaciones» que no dependen de la pasarela. */
function startProbe(readerToken, orderId) {
  const samples = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      const tick = performance.now();
      const [customers, summary] = await Promise.all([
        http('GET', '/v1/customers?pageSize=5', { token: readerToken }),
        orderId ? http('GET', `/web/v1/orders/${orderId}/summary`, { token: readerToken }) : Promise.resolve(null),
      ]);
      samples.push({ op: 'GET /v1/customers', status: customers.status, code: customers.code, ms: customers.ms });
      if (summary) samples.push({ op: 'GET resumen BFF', status: summary.status, code: summary.code, ms: summary.ms });
      const wait = PROBE_INTERVAL_MS - (performance.now() - tick);
      if (wait > 0) await sleep(wait);
    }
  })();
  return async () => { running = false; await loop; return samples; };
}

function describeProbe(samples) {
  const byOp = {};
  for (const op of new Set(samples.map((sample) => sample.op))) {
    const opSamples = samples.filter((sample) => sample.op === op);
    byOp[op] = { ...latencyStats(opSamples), statuses: countBy(opSamples, statusKey) };
  }
  return byOp;
}

async function arm(name, protectedArm, referenceOrderId) {
  const flags = protectedArm
    ? PAYMENTS_DEFAULTS
    : { ...PAYMENTS_DEFAULTS, PAYMENTS_CIRCUIT_BREAKER_ENABLED: 'false', PAYMENTS_BULKHEAD_ENABLED: 'false', PAYMENTS_GATEWAY_TIMEOUT_MS: '30000' };
  title(`Escenario 3 — ${name}`);
  step(`Pagos con Circuit Breaker=${flags.PAYMENTS_CIRCUIT_BREAKER_ENABLED}, Bulkhead=${flags.PAYMENTS_BULKHEAD_ENABLED} (máx ${flags.PAYMENTS_BULKHEAD_MAX_CONCURRENT}), timeout pasarela ${flags.PAYMENTS_GATEWAY_TIMEOUT_MS} ms`);
  await setPasarela(PASARELA_NORMAL);
  recreate('payments-api', flags);

  const stamp = Date.now();
  const operators = Array.from({ length: PEAK_CLIENTS }, (_, i) => token(`demo-pico-${name.replace(/\W+/g, '-')}-${i}-${stamp}`, 'operator'));
  // Una identidad de sonda por fase: la cuota del Gateway es por cliente y no
  // debe confundirse con el efecto que se mide.
  const probeToken = (phase) => token(`demo-sonda-${phase}-${protectedArm ? 'p' : 'u'}-${stamp}`, 'reader');
  const customerId = await newCustomer(operators[0], `pico-${protectedArm ? 'protegido' : 'sin'}`);
  const keys = [];
  const stockBefore = stock();
  const pasarelaBefore = (await pasarela()).stats;
  const logSince = new Date().toISOString();
  const result = { arm: name, protected: protectedArm, flags, phases: {} };

  // Fase A: pasarela lenta + pico de ventas concurrentes.
  step(`Fase A: pasarela LENTA (${SLOW_DELAY_MS} ms) y pico de ${PEAK_SALES} ventas simultáneas de ${PEAK_CLIENTS} clientes`);
  await setPasarela({ mode: 'slow', slowDelayMs: SLOW_DELAY_MS });
  const stopProbeA = startProbe(probeToken('lenta'), referenceOrderId);
  await sleep(500);
  const peakStarted = performance.now();
  const peak = await Promise.all(Array.from({ length: PEAK_SALES }, (_, i) => {
    const key = `demo-pico-${protectedArm ? 'p' : 'u'}-${randomUUID()}`;
    keys.push(key);
    return sell(operators[i % PEAK_CLIENTS], customerId, key);
  }));
  const peakWallMs = performance.now() - peakStarted;
  await sleep(500);
  const probeA = await stopProbeA();
  const resilienceA = await resiliencia();
  const peakSamples = peak.map((response) => ({ status: response.status, code: response.code, ms: response.ms }));
  result.phases.slow = {
    sales: { ...latencyStats(peakSamples), statuses: countBy(peakSamples, statusKey), wallMs: Math.round(peakWallMs) },
    otherOperations: describeProbe(probeA),
    resilience: resilienceA,
  };
  info(`ventas: ${JSON.stringify(result.phases.slow.sales.statuses)}; p50 ${result.phases.slow.sales.p50} ms, p95 ${result.phases.slow.sales.p95} ms; el pico tardó ${Math.round(peakWallMs)} ms`);
  info(`circuito ${resilienceA.circuitBreaker.state} (aperturas ${resilienceA.circuitBreaker.openedCount}, rechazos ${resilienceA.circuitBreaker.rejectedCalls}); bulkhead pico en vuelo ${resilienceA.bulkhead.peakInFlight}, rechazos ${resilienceA.bulkhead.rejectedCalls}`);
  for (const [op, stats] of Object.entries(result.phases.slow.otherOperations)) info(`${op} durante el pico: p95 ${stats.p95} ms ${JSON.stringify(stats.statuses)}`);

  // Fase B: pasarela caída.
  step(`Fase B: pasarela CAÍDA y ${DOWN_SALES} ventas seguidas`);
  await setPasarela({ mode: 'down' });
  const callsBeforeDown = (await pasarela()).stats.apiRequests;
  const stopProbeB = startProbe(probeToken('caida'), referenceOrderId);
  const down = [];
  for (let i = 0; i < DOWN_SALES; i += 1) {
    const key = `demo-caida-${protectedArm ? 'p' : 'u'}-${randomUUID()}`;
    keys.push(key);
    const response = await sell(operators[i % PEAK_CLIENTS], customerId, key);
    down.push({ status: response.status, code: response.code, ms: response.ms });
    info(`  venta ${String(i + 1).padStart(2)}: ${response.status} ${response.code ?? ''} en ${Math.round(response.ms)} ms`);
  }
  const probeB = await stopProbeB();
  const resilienceB = await resiliencia();
  const callsAfterDown = (await pasarela()).stats.apiRequests;
  result.phases.down = {
    sales: { ...latencyStats(down), statuses: countBy(down, statusKey), perSale: down.map((s) => ({ ...s, ms: Math.round(s.ms) })) },
    pasarelaCalls: callsAfterDown - callsBeforeDown,
    otherOperations: describeProbe(probeB),
    resilience: resilienceB,
  };
  info(`llamadas que llegaron a la pasarela caída: ${callsAfterDown - callsBeforeDown} de ${DOWN_SALES} ventas; circuito ${resilienceB.circuitBreaker.state}, aperturas ${resilienceB.circuitBreaker.openedCount}`);

  // Fase C: la pasarela vuelve.
  step('Fase C: la pasarela vuelve a la normalidad');
  await setPasarela(PASARELA_NORMAL);
  const recovery = [];
  const recoveryStarted = Date.now();
  for (let i = 0; i < 12; i += 1) {
    const key = `demo-recupera-${protectedArm ? 'p' : 'u'}-${randomUUID()}`;
    keys.push(key);
    const response = await sell(operators[i % PEAK_CLIENTS], customerId, key);
    recovery.push({ atMs: Date.now() - recoveryStarted, status: response.status, code: response.code, ms: Math.round(response.ms) });
    if (response.status === 201) break;
    await sleep(1000);
  }
  const recovered = recovery.at(-1);
  info(`primera venta aceptada ${recovered.atMs} ms después de restaurar la pasarela (${recovery.length} intentos)`);
  result.phases.recovery = { attempts: recovery, resilience: await resiliencia() };

  // Consistencia final.
  const sagaStatus = await settle(keys, 'consistencia');
  const stockAfter = stock();
  const pasarelaAfter = (await pasarela()).stats;
  const confirmed = sagaStatus.COMPLETED ?? 0;
  // Una anulación (void) bloquea una clave de cobro que nunca llegó: no resta cobros.
  const netCharges = (pasarelaAfter.chargesApproved - pasarelaBefore.chargesApproved) - (pasarelaAfter.refunds - pasarelaBefore.refunds);
  result.consistency = {
    sagas: sagaStatus, stock: { before: stockBefore, after: stockAfter }, confirmedSales: confirmed,
    pasarela: {
      chargesApproved: pasarelaAfter.chargesApproved - pasarelaBefore.chargesApproved,
      refunds: pasarelaAfter.refunds - pasarelaBefore.refunds,
      voids: pasarelaAfter.voids - pasarelaBefore.voids,
      apiRequests: pasarelaAfter.apiRequests - pasarelaBefore.apiRequests,
      netCharges,
    },
  };
  info(`ventas confirmadas ${confirmed}; stock ${stockBefore} -> ${stockAfter}; cobros netos en la pasarela ${netCharges}`);
  check(stockBefore - stockAfter === confirmed, 'cada unidad descontada corresponde a una venta confirmada');
  check(netCharges === confirmed, 'cada cobro neto en la pasarela corresponde a una venta confirmada');
  result.logs = logsSince(['payments-api'], logSince, /circuit|Circuit|OPEN|HALF_OPEN|CLOSED/);
  return result;
}

async function cascada(referenceOrderId) {
  const evidence = { config: { peakSales: PEAK_SALES, peakClients: PEAK_CLIENTS, downSales: DOWN_SALES, slowDelayMs: SLOW_DELAY_MS, probeIntervalMs: PROBE_INTERVAL_MS } };
  try {
    evidence.protected = await arm('CON protecciones (Circuit Breaker + Bulkhead + timeout 1,2 s)', true, referenceOrderId);
    evidence.unprotected = await arm('SIN protecciones (sin circuito ni bulkhead, timeout 30 s)', false, referenceOrderId);
  } finally {
    step('Se restauran la pasarela (normal) y Pagos (protecciones por defecto)');
    await setPasarela(PASARELA_NORMAL).catch(() => {});
    recreate('payments-api', PAYMENTS_DEFAULTS);
  }
  title('Comparación');
  const row = (label, a) => info(`${label.padEnd(16)} lenta: ventas p50 ${a.phases.slow.sales.p50} ms / p95 ${a.phases.slow.sales.p95} ms ${JSON.stringify(a.phases.slow.sales.statuses)}  |  caída: p95 ${a.phases.down.sales.p95} ms, ${a.phases.down.pasarelaCalls} llamadas a la pasarela`);
  row('Con protección', evidence.protected);
  row('Sin protección', evidence.unprotected);
  return evidence;
}

// ---------------------------------------------------------------------------

async function main() {
  const [command = 'todo', ...rest] = process.argv.slice(2);
  const outIndex = rest.indexOf('--out');
  const outDir = outIndex >= 0 ? rest[outIndex + 1] : join('evidencia', new Date().toISOString().replace(/[:.]/g, '-'));
  const valid = ['exposicion', 'exito', 'compensacion', 'cascada', 'todo'];
  if (!valid.includes(command)) {
    console.error(`uso: node scripts/demo/escenarios.mjs <${valid.join('|')}> [--out <dir>]`);
    process.exit(2);
  }
  mkdirSync(outDir, { recursive: true });
  const meta = { gateway: GATEWAY_URL, startedAt: new Date().toISOString(), sagaSteps: containerEnv('sales-api', 'SAGA_STEPS') };
  info(`Gateway ${GATEWAY_URL}; SAGA_STEPS=${meta.sagaSteps}`);
  if (meta.sagaSteps !== 'stock,payment,dispatch') throw new DemoError('la demo requiere la Saga completa (SAGA_STEPS=stock,payment,dispatch)');

  const write = (name, data) => {
    const path = join(outDir, `${name}.json`);
    writeFileSync(path, `${JSON.stringify({ ...meta, finishedAt: new Date().toISOString(), ...data }, null, 2)}\n`);
    info(`evidencia: ${path}`);
  };

  let referenceOrderId;
  if (command === 'exposicion' || command === 'todo') write('exposicion', await exposicion());
  if (command === 'exito' || command === 'todo') {
    const evidence = await exito();
    referenceOrderId = evidence.orderId;
    write('escenario1-exito', evidence);
  }
  if (command === 'compensacion' || command === 'todo') write('escenario2-compensacion', await compensacion());
  if (command === 'cascada' || command === 'todo') write('escenario3-cascada', await cascada(referenceOrderId));
  console.log(`\n${paint('1;32', 'Listo.')} Evidencia en ${outDir}`);
}

main().catch((error) => {
  console.error(`\n${paint('1;31', '[falla]')} ${error instanceof DemoError ? error.message : error.stack}`);
  process.exit(1);
});
