#!/usr/bin/env node
// P4 independent runner. Run from the repository root:
//   node tests/t2/p4-independent.mjs
//   node tests/t2/p4-independent.mjs --no-build
//
// It uses an isolated Compose project (default repuestossur-p4-independent),
// its own Gateway port (default 8081), and never removes containers or
// volumes. It runs three sequential scenarios against the real stack:
//   1. SAGA_STEPS=stock
//   2. SAGA_STEPS=stock,dispatch
//   3. SAGA_STEPS=stock,dispatch with DISPATCH_FAIL_CREATE=true
// Pagos (P2) is absent: the runner never deploys a payment stub and never
// claims a three-step Saga or a charge/refund. It restores the initial
// SAGA_STEPS (or stock,dispatch) and DISPATCH_FAIL_CREATE=false in finally.
//
// Configuration: P4_TEST_PROJECT, P4_TEST_PORT, P4_GATEWAY_PUBLISHED_PORT.
// Secrets come from the terminal or a local .env.p4 (mode 600). Values are
// never printed. The final structured result is a single JSON line on stdout.

import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PART_ID,
  assert,
  assertLoopbackBaseUrl,
  assertUuid,
  createHttpClient,
  expectCode,
  expectStatus,
  readContainerEnv,
  resolveSmokeMode,
  tokenFromCli,
} from './p4-smoke.mjs';

export const DEFAULT_PROJECT = 'repuestossur-p4-independent';
export const DEFAULT_PORT = 8081;
export const PROJECT_PREFIX = 'repuestossur-p4-';
export const COMPOSE_FILES = Object.freeze(['docker-compose.yml', 'docker-compose.p4.yml']);
export const REQUIRED_SERVICES = Object.freeze([
  'api-gateway',
  'web-bff',
  'sales-api',
  'dispatch-api',
  'inventory-grpc',
  'sales-db',
  'inventory-db',
  'dispatch-db',
]);
const COMPOSE = ['compose', '-f', COMPOSE_FILES[0], '-f', COMPOSE_FILES[1]];
const ENV_FILE = '.env.p4';
const BUILD_TIMEOUT_MS = 25 * 60_000;
const START_TIMEOUT_MS = 6 * 60_000;
const SMOKE_TIMEOUT_MS = 3 * 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const SUPPORTED_RESTORE_MODES = Object.freeze(['stock', 'stock,dispatch']);

export function parseArgs(argv = []) {
  let build = true;
  for (const arg of argv) {
    if (arg === '--no-build') build = false;
    else if (arg === '--help' || arg === '-h') return { help: true, build };
    else throw new Error(`unknown argument: ${arg}`);
  }
  return { help: false, build };
}

export function validateProjectName(raw) {
  const value = raw === undefined || raw === null || String(raw).trim() === ''
    ? DEFAULT_PROJECT
    : String(raw).trim();
  if (value === 'default' || value === 'repuestossur' || value === 'tarea-integracion-sistemas') {
    throw new Error('P4_TEST_PROJECT must not be the normal or default Compose project');
  }
  if (value.length > 63 || !/^repuestossur-p4-[a-z0-9][a-z0-9_-]*$/.test(value)) {
    throw new Error(`P4_TEST_PROJECT must match ${PROJECT_PREFIX}<name> (lowercase, digits, - or _)`);
  }
  return value;
}

export function validatePort(raw) {
  const value = raw === undefined || raw === null || String(raw).trim() === ''
    ? String(DEFAULT_PORT)
    : String(raw).trim();
  if (!/^[1-9][0-9]{0,4}$/.test(value)) throw new Error('P4_TEST_PORT must be a decimal TCP port');
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('P4_TEST_PORT must be between 1 and 65535');
  }
  return port;
}

export function validateEnvFile(path, {
  exists = existsSync,
  stat = statSync,
} = {}) {
  if (!exists(path)) return undefined;
  const info = stat(path);
  if (typeof info.isFile === 'function' && !info.isFile()) {
    throw new Error('.env.p4 must be a regular file');
  }
  const mode = info.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error('.env.p4 must not be group/world accessible; run chmod 600 .env.p4');
  }
  return path;
}

export function resolveEnvFile(env = process.env, {
  exists = existsSync,
  stat = statSync,
} = {}) {
  const candidate = resolve(ENV_FILE);
  const valid = validateEnvFile(candidate, { exists, stat });
  if (valid !== undefined) return valid;
  if (String(env.COMPOSE_ENV_FILES ?? '').trim() !== '') {
    throw new Error('COMPOSE_ENV_FILES is only accepted through a local .env.p4 (mode 600); export secrets instead');
  }
  return undefined;
}

export function buildComposeEnv({ project, port, envFile }, baseEnv = process.env) {
  const env = {
    ...baseEnv,
    COMPOSE_PROJECT_NAME: project,
    P4_GATEWAY_PUBLISHED_PORT: String(port),
    // Every command passes both -f flags; CLI flags override COMPOSE_FILE.
    // The empty shell values also keep .env.p4 from re-adding either setting.
    COMPOSE_FILE: '',
    COMPOSE_PROFILES: '',
  };
  if (envFile !== undefined) {
    env.COMPOSE_ENV_FILES = envFile;
    // Keep the explicit .env.p4 enabled even if the shell or dotenv says otherwise.
    env.COMPOSE_DISABLE_ENV_FILE = '0';
  } else {
    delete env.COMPOSE_ENV_FILES;
    // Exported secrets only: ignore a generic .env fallback.
    env.COMPOSE_DISABLE_ENV_FILE = '1';
  }
  return env;
}

export function resolveConfig({ argv = [], env = process.env, deps = {} } = {}) {
  const args = parseArgs(argv);
  const project = validateProjectName(env.P4_TEST_PROJECT);
  const port = validatePort(env.P4_TEST_PORT);
  const baseUrl = `http://127.0.0.1:${port}`;

  if (String(env.GATEWAY_BASE_URL ?? '').trim() !== '') {
    const requested = assertLoopbackBaseUrl(env.GATEWAY_BASE_URL);
    const normalized = requested.startsWith('http://localhost:')
      ? `http://127.0.0.1:${requested.slice('http://localhost:'.length)}`
      : requested;
    if (normalized !== baseUrl) {
      throw new Error(`GATEWAY_BASE_URL must equal ${baseUrl} for P4_TEST_PORT=${port}`);
    }
  }
  if (String(env.P4_GATEWAY_PUBLISHED_PORT ?? '').trim() !== '') {
    const published = validatePort(env.P4_GATEWAY_PUBLISHED_PORT);
    if (published !== port) {
      throw new Error('P4_GATEWAY_PUBLISHED_PORT must equal P4_TEST_PORT');
    }
  }
  if (String(env.COMPOSE_PROJECT_NAME ?? '').trim() !== ''
    && String(env.COMPOSE_PROJECT_NAME).trim() !== project) {
    throw new Error('COMPOSE_PROJECT_NAME conflicts with P4_TEST_PROJECT');
  }

  const envFile = resolveEnvFile(env, deps);
  return {
    project,
    port,
    baseUrl,
    build: args.build,
    help: args.help,
    envFile,
    composeEnv: buildComposeEnv({ project, port, envFile }, env),
    repoRoot: process.cwd(),
  };
}

export function assertRepositoryRoot(cwd = process.cwd()) {
  for (const file of COMPOSE_FILES) {
    if (!existsSync(resolve(cwd, file))) {
      throw new Error(`run this script from the repository root; missing ${file}`);
    }
  }
}

export function composeInvocation(config, args) {
  return {
    command: 'docker',
    args: [...COMPOSE, ...args],
    env: config.composeEnv,
  };
}

export function runComposeSync(config, args, {
  timeoutMs = 60_000,
  spawn: spawnImpl = spawnSync,
  env = config.composeEnv,
} = {}) {
  const result = spawnImpl('docker', [...COMPOSE, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    shell: false,
    maxBuffer: 1024 * 1024,
    env,
  });
  if (result.error !== undefined) {
    throw new Error(`docker compose failed: ${result.error.name}`);
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

export function parseComposeServices(stdout) {
  return String(stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function parsePsJson(stdout) {
  const text = String(stdout ?? '').trim();
  if (text === '') return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return text.split(/\r?\n/).filter(Boolean).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error('docker compose ps returned invalid JSON');
      }
    });
  }
}

export function labelsOf(entry) {
  const labels = entry?.Labels;
  if (typeof labels === 'string') {
    const parsed = {};
    // Compose stores config_files as a comma-separated value. Split only when
    // the next segment looks like a new key, not when it is another path.
    for (const pair of labels.split(/,(?=[A-Za-z0-9][A-Za-z0-9_.-]*=)/)) {
      const separator = pair.indexOf('=');
      if (separator > 0) parsed[pair.slice(0, separator)] = pair.slice(separator + 1);
    }
    return parsed;
  }
  if (labels !== null && typeof labels === 'object' && !Array.isArray(labels)) return labels;
  return {};
}

export function publishersOf(entry) {
  return Array.isArray(entry?.Publishers) ? entry.Publishers : [];
}

function entryPublishesPort(entry, port) {
  const fromPublishers = publishersOf(entry).some((publisher) => (
    Number(publisher.PublishedPort) === port
      && Number(publisher.TargetPort) === 8080
      && String(publisher.Protocol ?? 'tcp') === 'tcp'
  ));
  if (fromPublishers) return true;
  const ports = String(entry?.Ports ?? '');
  return ports.includes(`:${port}->8080/tcp`);
}

export function projectPublishesPort(entries, port) {
  return entries.some((entry) => {
    const labels = labelsOf(entry);
    return labels['com.docker.compose.service'] === 'api-gateway' && entryPublishesPort(entry, port);
  });
}

export function validateContainerLabels(entry, config) {
  const labels = labelsOf(entry);
  if (labels['com.docker.compose.project'] !== config.project) {
    throw new Error(`container does not belong to project ${config.project}`);
  }
  const service = labels['com.docker.compose.service'];
  if (typeof service !== 'string' || service === '') {
    throw new Error(`container in project ${config.project} has no Compose service label`);
  }
  const files = String(labels['com.docker.compose.project.config_files'] ?? '')
    .split(',')
    .map((file) => file.trim().split(/[\\/]/).pop())
    .filter(Boolean);
  if (!files.includes(COMPOSE_FILES[0]) || !files.includes(COMPOSE_FILES[1])) {
    throw new Error(`project ${config.project} was not created from the expected Compose files`);
  }
  return service;
}

export function validateProjectContainers(entries, config) {
  if (!Array.isArray(entries)) throw new Error('docker compose ps did not return a list');
  const services = new Map();
  for (const entry of entries) {
    const labels = labelsOf(entry);
    if (String(labels['com.docker.compose.oneoff'] ?? '').toLowerCase() === 'true') continue;
    const service = validateContainerLabels(entry, config);
    const state = String(entry?.State ?? '').toLowerCase();
    if (state !== 'running') {
      throw new Error(`project ${config.project} service ${service} is not running; start or stop it manually`);
    }
    services.set(service, entry);
  }
  if (services.size > 0) {
    const missing = REQUIRED_SERVICES.filter((service) => !services.has(service));
    if (missing.length > 0) {
      throw new Error(`project ${config.project} is incomplete; missing ${missing.join(', ')}`);
    }
  }
  return services;
}

export function buildUpArgs({
  build = true,
  services,
  forceRecreate = false,
  waitTimeoutSeconds = 300,
} = {}) {
  const args = ['up', '-d', '--wait', '--wait-timeout', String(waitTimeoutSeconds)];
  args.push(build ? '--build' : '--no-build');
  if (Array.isArray(services) && services.length > 0) {
    for (const service of services) {
      if (!/^[a-z0-9-]+$/.test(service)) throw new Error(`invalid Compose service: ${service}`);
    }
    if (forceRecreate) args.push('--force-recreate');
    args.push('--no-deps', ...services);
  }
  return args;
}

export function probePort(port, {
  connectImpl = connect,
  timeoutMs = 500,
} = {}) {
  return new Promise((resolvePromise) => {
    const socket = connectImpl({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (busy) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(busy);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', (error) => finish(error?.code === 'ECONNREFUSED' ? false : true));
    socket.setTimeout(timeoutMs, () => finish(true));
  });
}

export async function preflight(config, {
  run,
  probe = probePort,
} = {}) {
  const composeRun = run ?? ((args, timeoutMs = 60_000) => runComposeSync(config, args, { timeoutMs }));

  const configResult = composeRun(['config', '--quiet'], 30_000);
  if (configResult.status !== 0) {
    throw new Error('docker compose config failed; check .env.p4 or exported secrets');
  }

  const servicesResult = composeRun(['config', '--services'], 30_000);
  if (servicesResult.status !== 0) throw new Error('docker compose config --services failed');
  const services = parseComposeServices(servicesResult.stdout);
  const missing = REQUIRED_SERVICES.filter((service) => !services.includes(service));
  if (missing.length > 0) {
    throw new Error(`Compose is missing required services: ${missing.join(', ')}`);
  }

  const psResult = composeRun(['ps', '--all', '--format', 'json'], 30_000);
  if (psResult.status !== 0) throw new Error('docker compose ps failed');
  const entries = parsePsJson(psResult.stdout);
  const activeServices = validateProjectContainers(entries, config);
  const hasContainers = activeServices.size > 0;

  if (!projectPublishesPort(entries, config.port)) {
    const busy = await probe(config.port);
    if (busy) {
      throw new Error(`127.0.0.1:${config.port} is already in use; choose another P4_TEST_PORT`);
    }
  }

  return { entries: hasContainers ? entries : [], hasContainers };
}

export function captureInitialState(config, {
  entries,
  run,
}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { sagaSteps: undefined, dispatchFailCreate: undefined };
  }
  const sagaSteps = resolveSmokeMode({
    actual: readContainerEnv('sales-api', 'SAGA_STEPS', { run }),
  });
  const dispatchFailCreate = readContainerEnv('dispatch-api', 'DISPATCH_FAIL_CREATE', { run });
  if (dispatchFailCreate !== 'true' && dispatchFailCreate !== 'false') {
    throw new Error('DISPATCH_FAIL_CREATE in dispatch-api must be true or false');
  }
  return { sagaSteps, dispatchFailCreate };
}

export function buildGetPartScript(partId = PART_ID) {
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(partId), 'invalid partId');
  return `
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
const definition = protoLoader.loadSync(
  '/repo/contracts/grpc/repuestossur/inventory/v1/inventory.proto',
  { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true },
);
const pkg = grpc.loadPackageDefinition(definition);
const Client = pkg.repuestossur.inventory.v1.InventoryService;
const client = new Client('127.0.0.1:50051', grpc.credentials.createInsecure());
const finish = (code, value) => {
  try { client.close(); } catch {}
  if (code === 0) process.stdout.write(String(value), () => process.exit(0));
  else process.exit(code);
};
client.getPart(
  { part_id: ${JSON.stringify(partId)} },
  { deadline: Date.now() + 2000 },
  (error, response) => {
    if (error) return finish(2);
    const stock = response && response.part ? response.part.stock_available : undefined;
    if (!Number.isSafeInteger(stock) || stock < 0) return finish(3);
    finish(0, stock);
  },
);
`;
}

export function getPartStock(config, {
  run,
  partId = PART_ID,
  timeoutMs = 10_000,
} = {}) {
  const composeRun = run ?? ((args, timeout) => runComposeSync(config, args, { timeoutMs: timeout }));
  const result = composeRun([
    'exec',
    '-T',
    'inventory-grpc',
    'node',
    '--input-type=module',
    '-e',
    buildGetPartScript(partId),
  ], timeoutMs);
  if (result.status !== 0) {
    throw new Error(`GetPart probe failed (exit ${result.status ?? 'unknown'})`);
  }
  const text = String(result.stdout ?? '').trim();
  if (!/^(0|[1-9][0-9]*)$/.test(text)) {
    throw new Error('GetPart probe returned an invalid stock value');
  }
  const stock = Number(text);
  if (!Number.isSafeInteger(stock) || stock < 0) {
    throw new Error('GetPart probe returned an unsafe stock value');
  }
  return stock;
}

export function runProcessSync(command, args, {
  timeoutMs = SMOKE_TIMEOUT_MS,
  env = process.env,
  cwd = process.cwd(),
  spawn: spawnImpl = spawnSync,
} = {}) {
  const result = spawnImpl(command, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    shell: false,
    maxBuffer: 1024 * 1024,
    env,
    cwd,
  });
  if (result.error !== undefined) throw new Error(`process failed: ${result.error.name}`);
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

export function runSmoke(config, mode, {
  run = runProcessSync,
  env = config.composeEnv,
} = {}) {
  const childEnv = {
    ...env,
    GATEWAY_BASE_URL: config.baseUrl,
    P4_SMOKE_EXPECT_STEPS: mode,
    P4_SMOKE_DISPATCH_FIXTURE: 'false',
  };
  delete childEnv.GATEWAY_READER_TOKEN;
  delete childEnv.GATEWAY_OPERATOR_TOKEN;

  const result = run(process.execPath, ['tests/t2/p4-smoke.mjs'], {
    timeoutMs: SMOKE_TIMEOUT_MS,
    env: childEnv,
    cwd: config.repoRoot,
  });
  if (result.status !== 0) {
    const last = String(result.stderr ?? '').trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
    throw new Error(`smoke ${mode} failed (exit ${result.status})${last === '' ? '' : `: ${last}`}`);
  }
  return { mode, status: result.status };
}

export function runComposeUp(config, args, {
  timeoutMs = START_TIMEOUT_MS,
  env = config.composeEnv,
  spawn: spawnImpl = spawn,
} = {}) {
  return new Promise((resolvePromise, reject) => {
    let child;
    try {
      child = spawnImpl('docker', [...COMPOSE, ...args], {
        env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const append = (current, chunk) => {
      const next = current + String(chunk);
      return next.length > MAX_OUTPUT_BYTES ? next.slice(-MAX_OUTPUT_BYTES) : next;
    };
    let timer;
    let forceTimer;
    const clearTimers = () => {
      if (timer !== undefined) clearTimeout(timer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
    };
    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolvePromise({ code, signal, timedOut, stdout, stderr });
    });
  });
}

export async function upStack(config, {
  sagaSteps,
  dispatchFailCreate,
  services,
  build = false,
  forceRecreate = false,
  runUp = runComposeUp,
  waitTimeoutSeconds = Array.isArray(services) && services.length > 0 ? 180 : 300,
} = {}) {
  const env = {
    ...config.composeEnv,
    SAGA_STEPS: sagaSteps,
    DISPATCH_FAIL_CREATE: String(dispatchFailCreate),
  };
  const args = buildUpArgs({ build, services, forceRecreate, waitTimeoutSeconds });
  const result = await runUp(config, args, {
    env,
    timeoutMs: build ? BUILD_TIMEOUT_MS : START_TIMEOUT_MS,
  });
  if (result.timedOut || result.code !== 0) {
    const detail = result.timedOut ? 'timeout' : `exit ${result.code ?? result.signal ?? 'unknown'}`;
    throw new Error(`docker compose up failed (${detail})`);
  }
  return { sagaSteps, dispatchFailCreate };
}

export function scenarioDefinitions() {
  return [
    {
      name: 'stock',
      sagaSteps: 'stock',
      dispatchFailCreate: false,
      services: undefined,
      forceRecreate: false,
      smoke: true,
    },
    {
      name: 'stock,dispatch',
      sagaSteps: 'stock,dispatch',
      dispatchFailCreate: false,
      services: ['sales-api', 'dispatch-api'],
      forceRecreate: true,
      smoke: true,
    },
    {
      name: 'dispatch-failure',
      sagaSteps: 'stock,dispatch',
      dispatchFailCreate: true,
      services: ['dispatch-api'],
      forceRecreate: true,
      smoke: false,
    },
  ];
}

async function waitForGateway(httpClient, {
  attempts = 60,
  delayMs = 500,
} = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await httpClient('/health');
      if (response.status === 200 && response.json?.service === 'gateway') return;
    } catch {
      // The stack may still be starting; retry with a bounded delay.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
  }
  throw new Error('gateway health did not become ready');
}

export async function runDispatchFailure({
  config,
  http: httpClient,
  stock,
  run,
  log = () => {},
  partId = PART_ID,
  tokenProvider = tokenFromCli,
}) {
  const subject = `p4-independent-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const operator = tokenProvider('operator', `${subject}-operator`, { run });
  const reader = tokenProvider('reader', `${subject}-reader`, { run });
  const before = await stock();

  const customer = await httpClient('/v1/customers', {
    method: 'POST',
    token: operator,
    body: {
      name: 'P4 independent failure customer',
      email: `p4-independent-${Date.now()}-${randomUUID().slice(0, 8)}@example.invalid`,
    },
  });
  expectStatus(customer, 201, 'failure customer');
  const customerId = customer.json?.id;
  assertUuid(customerId, 'failure customer');

  const body = { customerId, items: [{ partId, quantity: 1 }] };
  const key = `p4-independent-failure-${randomUUID()}`;
  const orderOptions = {
    method: 'POST',
    token: operator,
    headers: { 'Idempotency-Key': key },
    body,
  };

  let first;
  try {
    first = await httpClient('/v1/orders', orderOptions);
  } catch {
    log(`[recovery] Idempotency-Key=${key}`);
    throw new Error('failure order ambiguous; recovery pending by Idempotency-Key');
  }
  try {
    expectStatus(first, 503, 'dispatch failure order');
    expectCode(first, 'DISPATCH_UNAVAILABLE', 'dispatch failure order');
    assertUuid(first.json?.traceId, 'dispatch failure traceId');
    assert(
      first.headers.get('x-trace-id') === first.json.traceId,
      'dispatch failure: X-Trace-Id does not match the body traceId',
    );
    assert(
      JSON.stringify(Object.keys(first.json ?? {}).sort()) === JSON.stringify(['code', 'message', 'traceId']),
      'dispatch failure: unexpected error envelope fields',
    );
    assert(first.json.message === 'Dispatch service is unavailable', 'dispatch failure: unexpected message');
  } catch (error) {
    log(`[recovery] Idempotency-Key=${key}`);
    throw error;
  }

  const afterFirst = await stock();
  if (afterFirst !== before) log(`[recovery] Idempotency-Key=${key}`);
  assert(afterFirst === before, 'dispatch failure: stock was not restored after the first 503');

  let replay;
  try {
    replay = await httpClient('/v1/orders', orderOptions);
  } catch {
    log(`[recovery] Idempotency-Key=${key}`);
    throw new Error('failure replay ambiguous; recovery pending by Idempotency-Key');
  }
  try {
    expectStatus(replay, 503, 'dispatch failure replay');
    expectCode(replay, 'DISPATCH_UNAVAILABLE', 'dispatch failure replay');
    assertUuid(replay.json?.traceId, 'dispatch failure replay traceId');
    assert(
      replay.headers.get('x-trace-id') === replay.json.traceId,
      'dispatch failure replay: X-Trace-Id does not match the body traceId',
    );
  } catch (error) {
    log(`[recovery] Idempotency-Key=${key}`);
    throw error;
  }

  const afterReplay = await stock();
  if (afterReplay !== before) log(`[recovery] Idempotency-Key=${key}`);
  assert(afterReplay === before, 'dispatch failure: stock was not restored after the replay');

  for (const token of [reader, operator]) {
    const orders = await httpClient(`/v1/orders?customerId=${customerId}`, { token });
    expectStatus(orders, 200, 'orders after dispatch failure');
    if (orders.json?.total !== 0) log(`[recovery] Idempotency-Key=${key}`);
    assert(orders.json?.total === 0, 'dispatch failure: a public order was created');
    assert(
      Array.isArray(orders.json?.items) && orders.json.items.length === 0,
      'dispatch failure: public order list is not empty',
    );
  }

  const customers = await httpClient('/v1/customers', { token: reader });
  expectStatus(customers, 200, 'customers while dispatch fails');

  return {
    status: first.status,
    code: first.json.code,
    replayStatus: replay.status,
    replayCode: replay.json.code,
    publicOrders: 0,
    stockBefore: before,
    stockAfterFirst: afterFirst,
    stockAfter: afterReplay,
    customersStatus: customers.status,
  };
}

export async function runScenarios(config, {
  http: httpClient = createHttpClient(config.baseUrl),
  stock = () => getPartStock(config),
  smoke = (mode) => runSmoke(config, mode),
  up = (options) => upStack(config, options),
  run = (args, timeoutMs) => runComposeSync(config, args, { timeoutMs }),
  dispatchFailure = runDispatchFailure,
  log = () => {},
  state = { modes: [], failure: null },
} = {}) {
  const plan = scenarioDefinitions();

  log(`[scenario 1] ${plan[0].sagaSteps} with DISPATCH_FAIL_CREATE=false`);
  await up({
    sagaSteps: plan[0].sagaSteps,
    dispatchFailCreate: plan[0].dispatchFailCreate,
    build: config.build,
  });
  await waitForGateway(httpClient);
  const stockBefore1 = await stock();
  await smoke(plan[0].sagaSteps);
  const stockAfter1 = await stock();
  assert(stockAfter1 === stockBefore1, 'stock scenario did not restore the initial stock');
  state.modes.push({
    name: plan[0].name,
    smoke: 'passed',
    stockBefore: stockBefore1,
    stockAfter: stockAfter1,
  });

  log(`[scenario 2] ${plan[1].sagaSteps} with a real dispatch`);
  await up({
    sagaSteps: plan[1].sagaSteps,
    dispatchFailCreate: plan[1].dispatchFailCreate,
    services: plan[1].services,
    forceRecreate: plan[1].forceRecreate,
    build: false,
  });
  const stockBefore2 = await stock();
  assert(stockBefore2 === stockAfter1, 'scenario 2 did not start from the scenario 1 stock');
  await smoke(plan[1].sagaSteps);
  const stockAfter2 = await stock();
  assert(stockAfter2 === stockBefore2, 'stock,dispatch scenario did not restore the initial stock');
  state.modes.push({
    name: plan[1].name,
    smoke: 'passed',
    stockBefore: stockBefore2,
    stockAfter: stockAfter2,
  });

  log(`[scenario 3] ${plan[2].sagaSteps} with DISPATCH_FAIL_CREATE=true`);
  await up({
    sagaSteps: plan[2].sagaSteps,
    dispatchFailCreate: plan[2].dispatchFailCreate,
    services: plan[2].services,
    forceRecreate: plan[2].forceRecreate,
    build: false,
  });
  const failure = await dispatchFailure({
    config,
    http: httpClient,
    stock,
    run,
    log,
  });
  assert(
    failure.stockBefore === stockAfter2,
    'scenario 3 did not start from the scenario 2 stock',
  );
  state.failure = failure;
  state.modes.push({
    name: plan[2].name,
    status: failure.status,
    code: failure.code,
    replayStatus: failure.replayStatus,
    replayCode: failure.replayCode,
    publicOrders: failure.publicOrders,
    stockBefore: failure.stockBefore,
    stockAfterFirst: failure.stockAfterFirst,
    stockAfter: failure.stockAfter,
    customersStatus: failure.customersStatus,
  });

  return state;
}

export async function restoreStack(config, initialState, {
  up = (options) => upStack(config, options),
  readEnv = (service, name) => readContainerEnv(service, name, {
    run: (args, timeout) => runComposeSync(config, args, { timeoutMs: timeout }),
  }),
  log = () => {},
} = {}) {
  const sagaSteps = initialState?.sagaSteps ?? 'stock,dispatch';
  if (!SUPPORTED_RESTORE_MODES.includes(sagaSteps)) {
    throw new Error(`cannot restore unsupported SAGA_STEPS=${sagaSteps}`);
  }

  log(`[restore] SAGA_STEPS=${sagaSteps} and DISPATCH_FAIL_CREATE=false`);
  await up({
    sagaSteps,
    dispatchFailCreate: false,
    services: ['sales-api', 'dispatch-api'],
    forceRecreate: true,
    build: false,
  });

  const actualSaga = readEnv('sales-api', 'SAGA_STEPS');
  const actualFail = readEnv('dispatch-api', 'DISPATCH_FAIL_CREATE');
  if (actualSaga !== sagaSteps) {
    throw new Error(`restore failed: SAGA_STEPS is ${actualSaga}, expected ${sagaSteps}`);
  }
  if (actualFail !== 'false') {
    throw new Error(`restore failed: DISPATCH_FAIL_CREATE is ${actualFail}, expected false`);
  }
  return { sagaSteps: actualSaga, dispatchFailCreate: actualFail, verified: true };
}

export async function executeWithRestore({ run, restore, shouldRestore = true }) {
  let result;
  let failure;
  let restored;
  let restoreFailure;

  try {
    result = await run();
  } catch (error) {
    failure = error;
  }

  if (shouldRestore) {
    try {
      restored = await restore();
    } catch (error) {
      restoreFailure = error;
    }
  }

  return { result, failure, restored, restoreFailure };
}

function safeError(error) {
  const name = error instanceof Error ? error.name : 'UnknownError';
  const message = error instanceof Error ? error.message : 'unknown error';
  return {
    name,
    message: message.replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      '<uuid>',
    ),
  };
}

export function usage() {
  return [
    'Usage: node tests/t2/p4-independent.mjs [--no-build]',
    '  P4_TEST_PROJECT  isolated project (default repuestossur-p4-independent)',
    '  P4_TEST_PORT     Gateway host port (default 8081)',
    '  Secrets: export GATEWAY_JWT_SECRET/API keys or use .env.p4 (mode 600).',
    '  No containers, volumes or images are removed by this runner.',
  ].join('\n');
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  deps = {},
} = {}) {
  if (parseArgs(argv).help) {
    process.stdout.write(`${usage()}\n`);
    return { help: true };
  }
  const config = resolveConfig({ argv, env, deps });

  const log = (message) => process.stderr.write(`${message}\n`);
  const httpClient = createHttpClient(config.baseUrl);
  const composeRun = deps.composeRun
    ?? ((args, timeoutMs = 60_000) => runComposeSync(config, args, { timeoutMs }));
  let initialState = { sagaSteps: undefined, dispatchFailCreate: undefined };
  let touched = false;
  const scenarioState = { modes: [], failure: null };

  const outcome = await executeWithRestore({
    run: async () => {
      assertRepositoryRoot(config.repoRoot);
      const preflightResult = await preflight(config, {
        run: deps.preflightRun ?? composeRun,
        probe: deps.probe,
      });
      initialState = captureInitialState(config, {
        entries: preflightResult.entries,
        run: deps.captureRun ?? composeRun,
      });
      touched = true;
      return runScenarios(config, {
        http: httpClient,
        log,
        ...deps.scenarios,
        run: deps.scenarios?.run ?? composeRun,
        state: scenarioState,
      });
    },
    restore: async () => {
      if (!touched) return undefined;
      return restoreStack(config, initialState, {
        log,
        ...deps.restore,
      });
    },
  });

  const report = {
    status: outcome.failure !== undefined || outcome.restoreFailure !== undefined ? 'failed' : 'passed',
    project: config.project,
    port: config.port,
    build: config.build,
    pagos: 'absent',
    modes: scenarioState.modes,
    dispatchFailure: scenarioState.failure,
    restore: outcome.restored ?? { skipped: true },
  };
  if (outcome.failure !== undefined) report.error = safeError(outcome.failure);
  if (outcome.restoreFailure !== undefined) report.restoreError = safeError(outcome.restoreFailure);

  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (outcome.failure !== undefined || outcome.restoreFailure !== undefined) {
    process.exitCode = 1;
  }
  return report;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    const safe = safeError(error);
    process.stderr.write(`[fail] ${safe.message}\n`);
    process.exitCode = 1;
  }
}
