import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PORT,
  DEFAULT_PROJECT,
  REQUIRED_SERVICES,
  buildComposeEnv,
  buildGetPartScript,
  buildUpArgs,
  captureInitialState,
  composeInvocation,
  executeWithRestore,
  getPartStock,
  labelsOf,
  main,
  parseArgs,
  parseComposeServices,
  parsePsJson,
  preflight,
  projectPublishesPort,
  resolveConfig,
  resolveEnvFile,
  restoreStack,
  runDispatchFailure,
  runScenarios,
  runSmoke,
  scenarioDefinitions,
  upStack,
  validateContainerLabels,
  validateEnvFile,
  validatePort,
  validateProjectContainers,
  validateProjectName,
} from './p4-independent.mjs';

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const TRACE_ID = '22222222-2222-4222-8222-222222222222';

function response(status, json, headers = {}) {
  return {
    status,
    json,
    text: JSON.stringify(json),
    headers: new Headers(headers),
  };
}

function container(service, {
  project = DEFAULT_PROJECT,
  files = 'docker-compose.yml,docker-compose.p4.yml',
  state = 'running',
} = {}) {
  return {
    State: state,
    Labels: {
      'com.docker.compose.project': project,
      'com.docker.compose.service': service,
      'com.docker.compose.project.config_files': files,
    },
  };
}

test('module import does not run the independent runner', () => {
  assert.equal(typeof main, 'function');
});

test('parseArgs accepts only --no-build and --help', () => {
  assert.deepEqual(parseArgs([]), { help: false, build: true });
  assert.deepEqual(parseArgs(['--no-build']), { help: false, build: false });
  assert.deepEqual(parseArgs(['--help']), { help: true, build: true });
  assert.throws(() => parseArgs(['--build']), /unknown argument/);
});

test('project and port guards reject the normal project and invalid values', () => {
  assert.equal(validateProjectName(undefined), DEFAULT_PROJECT);
  assert.equal(validateProjectName('repuestossur-p4-test_1'), 'repuestossur-p4-test_1');
  assert.throws(() => validateProjectName('tarea-integracion-sistemas'), /normal or default/);
  assert.throws(() => validateProjectName('default'), /normal or default/);
  assert.throws(() => validateProjectName('repuestossur-p4-'), /must match/);
  assert.throws(() => validateProjectName('Repuestossur-p4-test'), /must match/);
  assert.throws(() => validateProjectName('repuestossur-p4-../escape'), /must match/);
  assert.equal(validatePort(undefined), DEFAULT_PORT);
  assert.equal(validatePort('8082'), 8082);
  assert.throws(() => validatePort('0'), /decimal/);
  assert.throws(() => validatePort('65536'), /between 1 and 65535/);
  assert.throws(() => validatePort('8081abc'), /decimal/);
});

test('env file guard accepts only mode 600 and rejects an inherited path', () => {
  assert.equal(validateEnvFile('/x/.env.p4', { exists: () => false }), undefined);
  assert.equal(validateEnvFile('/x/.env.p4', {
    exists: () => true,
    stat: () => ({ mode: 0o100600 }),
  }), '/x/.env.p4');
  assert.throws(() => validateEnvFile('/x/.env.p4', {
    exists: () => true,
    stat: () => ({ mode: 0o100644 }),
  }), /chmod 600/);
  assert.equal(resolveEnvFile({}, { exists: () => false }), undefined);
  assert.throws(() => resolveEnvFile({ COMPOSE_ENV_FILES: '/tmp/other.env' }, {
    exists: () => false,
  }), /only accepted through a local \.env\.p4/);
  assert.match(resolveEnvFile({}, {
    exists: () => true,
    stat: () => ({ mode: 0o100600 }),
  }), /\.env\.p4$/);
});

test('resolveConfig derives the exact loopback URL and rejects conflicting env', () => {
  const env = {
    P4_TEST_PROJECT: 'repuestossur-p4-test',
    P4_TEST_PORT: '8082',
    GATEWAY_JWT_SECRET: 'not-a-real-secret',
  };
  const config = resolveConfig({
    argv: ['--no-build'],
    env,
    deps: { exists: () => false },
  });
  assert.equal(config.project, 'repuestossur-p4-test');
  assert.equal(config.port, 8082);
  assert.equal(config.baseUrl, 'http://127.0.0.1:8082');
  assert.equal(config.build, false);
  assert.equal(config.composeEnv.COMPOSE_PROJECT_NAME, 'repuestossur-p4-test');
  assert.equal(config.composeEnv.P4_GATEWAY_PUBLISHED_PORT, '8082');
  assert.equal(config.composeEnv.COMPOSE_FILE, '');
  assert.equal(config.composeEnv.COMPOSE_PROFILES, '');
  assert.equal(config.composeEnv.COMPOSE_ENV_FILES, undefined);
  assert.equal(config.composeEnv.COMPOSE_DISABLE_ENV_FILE, '1');

  const localhost = resolveConfig({
    env: { ...env, GATEWAY_BASE_URL: 'http://localhost:8082' },
    deps: { exists: () => false },
  });
  assert.equal(localhost.baseUrl, 'http://127.0.0.1:8082');

  assert.throws(() => resolveConfig({
    env: { ...env, GATEWAY_BASE_URL: 'http://127.0.0.1:8080' },
    deps: { exists: () => false },
  }), /must equal http:\/\/127\.0\.0\.1:8082/);
  assert.throws(() => resolveConfig({
    env: { ...env, GATEWAY_BASE_URL: 'http://192.168.1.10:8082' },
    deps: { exists: () => false },
  }), /127\.0\.0\.1 or localhost/);
  assert.throws(() => resolveConfig({
    env: { ...env, P4_GATEWAY_PUBLISHED_PORT: '8080' },
    deps: { exists: () => false },
  }), /must equal P4_TEST_PORT/);
  assert.throws(() => resolveConfig({
    env: { ...env, COMPOSE_PROJECT_NAME: 'default' },
    deps: { exists: () => false },
  }), /conflicts/);
  assert.throws(() => resolveConfig({
    env: { ...env, P4_TEST_PROJECT: 'tarea-integracion-sistemas' },
    deps: { exists: () => false },
  }), /normal or default/);
});

test('resolveConfig cleans inherited Compose file/profile controls', () => {
  const env = {
    P4_TEST_PROJECT: 'repuestossur-p4-test',
    P4_TEST_PORT: '8082',
    COMPOSE_FILE: '/tmp/evil.yml',
    COMPOSE_PROFILES: 'experiment',
    COMPOSE_DISABLE_ENV_FILE: '0',
  };
  const config = resolveConfig({
    env,
    deps: { exists: () => false },
  });
  assert.equal(config.composeEnv.COMPOSE_FILE, '');
  assert.equal(config.composeEnv.COMPOSE_PROFILES, '');
  assert.equal(config.composeEnv.COMPOSE_DISABLE_ENV_FILE, '1');

  const withFile = resolveConfig({
    env,
    deps: {
      exists: () => true,
      stat: () => ({ mode: 0o100600 }),
    },
  });
  assert.match(withFile.composeEnv.COMPOSE_ENV_FILES, /\.env\.p4$/);
  assert.equal(withFile.composeEnv.COMPOSE_FILE, '');
  assert.equal(withFile.composeEnv.COMPOSE_PROFILES, '');
  assert.equal(withFile.composeEnv.COMPOSE_DISABLE_ENV_FILE, '0');

  assert.deepEqual(env, {
    P4_TEST_PROJECT: 'repuestossur-p4-test',
    P4_TEST_PORT: '8082',
    COMPOSE_FILE: '/tmp/evil.yml',
    COMPOSE_PROFILES: 'experiment',
    COMPOSE_DISABLE_ENV_FILE: '0',
  });
});

test('buildComposeEnv clears inherited file/profile controls without mutating the parent', () => {
  const base = {
    COMPOSE_ENV_FILES: 'other',
    COMPOSE_FILE: '/tmp/evil.yml',
    COMPOSE_PROFILES: 'experiment,test',
    COMPOSE_DISABLE_ENV_FILE: '1',
    KEEP: '1',
  };
  const env = buildComposeEnv({
    project: 'repuestossur-p4-test',
    port: 8082,
    envFile: '/repo/.env.p4',
  }, base);
  assert.equal(env.COMPOSE_PROJECT_NAME, 'repuestossur-p4-test');
  assert.equal(env.P4_GATEWAY_PUBLISHED_PORT, '8082');
  assert.equal(env.COMPOSE_FILE, '');
  assert.equal(env.COMPOSE_PROFILES, '');
  assert.equal(env.COMPOSE_ENV_FILES, '/repo/.env.p4');
  assert.equal(env.COMPOSE_DISABLE_ENV_FILE, '0');
  assert.equal(env.KEEP, '1');

  const withoutFile = buildComposeEnv({
    project: 'repuestossur-p4-test',
    port: 8082,
    envFile: undefined,
  }, base);
  assert.equal(withoutFile.COMPOSE_FILE, '');
  assert.equal(withoutFile.COMPOSE_PROFILES, '');
  assert.equal(withoutFile.COMPOSE_ENV_FILES, undefined);
  assert.equal(withoutFile.COMPOSE_DISABLE_ENV_FILE, '1');

  assert.deepEqual(base, {
    COMPOSE_ENV_FILES: 'other',
    COMPOSE_FILE: '/tmp/evil.yml',
    COMPOSE_PROFILES: 'experiment,test',
    COMPOSE_DISABLE_ENV_FILE: '1',
    KEEP: '1',
  });
});

test('composeInvocation always uses both Compose files and the scoped env', () => {
  const config = { composeEnv: { COMPOSE_PROJECT_NAME: 'repuestossur-p4-test' } };
  const invocation = composeInvocation(config, ['ps']);
  assert.deepEqual(invocation.args.slice(0, 5), [
    'compose',
    '-f',
    'docker-compose.yml',
    '-f',
    'docker-compose.p4.yml',
  ]);
  assert.equal(invocation.args.at(-1), 'ps');
  assert.equal(invocation.env.COMPOSE_PROJECT_NAME, 'repuestossur-p4-test');
});

test('Compose ps and service parsers handle array, NDJSON and labels', () => {
  assert.deepEqual(parseComposeServices('api-gateway\nweb-bff\n'), ['api-gateway', 'web-bff']);
  assert.deepEqual(parsePsJson('[]'), []);
  assert.deepEqual(parsePsJson('[{"Service":"api-gateway"}]'), [{ Service: 'api-gateway' }]);
  assert.deepEqual(parsePsJson('{"Service":"a"}\n{"Service":"b"}'), [
    { Service: 'a' },
    { Service: 'b' },
  ]);
  assert.deepEqual(labelsOf({ Labels: 'a=b,c=d' }), { a: 'b', c: 'd' });
  assert.deepEqual(labelsOf({
    Labels: 'com.docker.compose.project=repuestossur-p4-test,'
      + 'com.docker.compose.project.config_files=/repo/docker-compose.yml,/repo/docker-compose.p4.yml,'
      + 'com.docker.compose.service=api-gateway',
  }), {
    'com.docker.compose.project': 'repuestossur-p4-test',
    'com.docker.compose.project.config_files': '/repo/docker-compose.yml,/repo/docker-compose.p4.yml',
    'com.docker.compose.service': 'api-gateway',
  });
  assert.deepEqual(labelsOf({ Labels: { a: 'b' } }), { a: 'b' });
  assert.deepEqual(labelsOf({}), {});
});

test('container labels must match project, config files and running state', () => {
  const config = { project: DEFAULT_PROJECT };
  const gateway = container('api-gateway');
  assert.equal(validateContainerLabels(gateway, config), 'api-gateway');
  assert.throws(() => validateContainerLabels(container('api-gateway', {
    project: 'repuestossur-p4-other',
  }), config), /does not belong/);
  assert.throws(() => validateContainerLabels(container('api-gateway', {
    files: 'docker-compose.yml',
  }), config), /expected Compose files/);

  const entries = REQUIRED_SERVICES.map((service) => container(service));
  assert.equal(validateProjectContainers(entries, config).size, REQUIRED_SERVICES.length);
  assert.throws(() => validateProjectContainers([gateway], config), /incomplete/);
  assert.throws(() => validateProjectContainers([
    container('api-gateway', { state: 'exited' }),
  ], config), /not running/);
});

test('published port detection uses Publishers or the Ports fallback', () => {
  assert.equal(projectPublishesPort([{
    Labels: { 'com.docker.compose.service': 'api-gateway' },
    Publishers: [{ PublishedPort: 8081, TargetPort: 8080, Protocol: 'tcp' }],
  }], 8081), true);
  assert.equal(projectPublishesPort([{
    Labels: { 'com.docker.compose.service': 'api-gateway' },
    Publishers: [{ PublishedPort: 8081, TargetPort: 8080, Protocol: 'tcp' }],
  }], 8082), false);
  assert.equal(projectPublishesPort([{
    Labels: { 'com.docker.compose.service': 'api-gateway' },
    Ports: '127.0.0.1:8081->8080/tcp',
  }], 8081), true);
  assert.equal(projectPublishesPort([{
    Labels: { 'com.docker.compose.service': 'web-bff' },
    Ports: '127.0.0.1:8081->8080/tcp',
  }], 8081), false);
});

test('buildUpArgs keeps build/no-build and service recreation explicit', () => {
  assert.deepEqual(buildUpArgs({ build: true }), [
    'up', '-d', '--wait', '--wait-timeout', '300', '--build',
  ]);
  assert.deepEqual(buildUpArgs({ build: false }), [
    'up', '-d', '--wait', '--wait-timeout', '300', '--no-build',
  ]);
  assert.deepEqual(buildUpArgs({
    build: false,
    services: ['sales-api', 'dispatch-api'],
    forceRecreate: true,
    waitTimeoutSeconds: 180,
  }), [
    'up', '-d', '--wait', '--wait-timeout', '180', '--no-build',
    '--force-recreate', '--no-deps', 'sales-api', 'dispatch-api',
  ]);
  assert.throws(() => buildUpArgs({ services: ['bad service'] }), /invalid Compose service/);
});

test('GetPart probe uses the documented proto and accepts only a safe stock', () => {
  assert.equal(getPartStock({}, {
    run: () => ({ status: 0, stdout: '5\n' }),
  }), 5);
  assert.throws(() => getPartStock({}, {
    run: () => ({ status: 1, stdout: '' }),
  }), /GetPart probe failed/);
  assert.throws(() => getPartStock({}, {
    run: () => ({ status: 0, stdout: '-1' }),
  }), /invalid stock/);
  assert.throws(() => getPartStock({}, {
    run: () => ({ status: 0, stdout: '5abc' }),
  }), /invalid stock/);
  const script = buildGetPartScript();
  assert.match(script, /keepCase: true/);
  assert.match(script, /\/repo\/contracts\/grpc\/repuestossur\/inventory\/v1\/inventory\.proto/);
  assert.match(script, /deadline: Date\.now\(\) \+ 2000/);
  assert.throws(() => buildGetPartScript('not-a-uuid'), /invalid partId/);
});

test('captureInitialState reads the real container env before mutations', () => {
  const run = (args) => {
    if (args.includes('sales-api')) return { status: 0, stdout: 'stock,dispatch\n' };
    if (args.includes('dispatch-api')) return { status: 0, stdout: 'false\n' };
    throw new Error('unexpected service');
  };
  assert.deepEqual(captureInitialState({}, { entries: [{}], run }), {
    sagaSteps: 'stock,dispatch',
    dispatchFailCreate: 'false',
  });
  assert.deepEqual(captureInitialState({}, { entries: [], run }), {
    sagaSteps: undefined,
    dispatchFailCreate: undefined,
  });
  assert.throws(() => captureInitialState({}, {
    entries: [{}],
    run: (args) => ({
      status: 0,
      stdout: args.includes('sales-api') ? 'stock,payment,dispatch' : 'false',
    }),
  }), /pendiente de integración P2/);
});

test('restoreStack always sets DISPATCH_FAIL_CREATE=false and verifies the result', async () => {
  const calls = [];
  const result = await restoreStack({}, { sagaSteps: 'stock' }, {
    up: async (options) => { calls.push(options); },
    readEnv: (service) => service === 'sales-api' ? 'stock' : 'false',
  });
  assert.deepEqual(result, { sagaSteps: 'stock', dispatchFailCreate: 'false', verified: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].services, ['sales-api', 'dispatch-api']);
  assert.equal(calls[0].sagaSteps, 'stock');
  assert.equal(calls[0].dispatchFailCreate, false);
  assert.equal(calls[0].forceRecreate, true);
  assert.equal(calls[0].build, false);

  await assert.rejects(restoreStack({}, { sagaSteps: 'stock' }, {
    up: async () => {},
    readEnv: () => 'stock,dispatch',
  }), /restore failed/);
  await assert.rejects(restoreStack({}, { sagaSteps: 'stock' }, {
    up: async () => { throw new Error('docker down'); },
    readEnv: () => 'stock',
  }), /docker down/);
  assert.equal((await restoreStack({}, {}, {
    up: async () => {},
    readEnv: (service) => service === 'sales-api' ? 'stock,dispatch' : 'false',
  })).sagaSteps, 'stock,dispatch');
});

test('executeWithRestore always attempts restore after a scenario failure', async () => {
  let restored = false;
  const failed = await executeWithRestore({
    run: async () => { throw new Error('scenario failed'); },
    restore: async () => { restored = true; return { verified: true }; },
  });
  assert.equal(restored, true);
  assert.equal(failed.failure.message, 'scenario failed');
  assert.equal(failed.restoreFailure, undefined);
  assert.deepEqual(failed.restored, { verified: true });

  const restoreFailed = await executeWithRestore({
    run: async () => ({ ok: true }),
    restore: async () => { throw new Error('restore failed'); },
  });
  assert.deepEqual(restoreFailed.result, { ok: true });
  assert.equal(restoreFailed.restoreFailure.message, 'restore failed');

  let skipped = false;
  await executeWithRestore({
    run: async () => ({}),
    restore: async () => { skipped = true; },
    shouldRestore: false,
  });
  assert.equal(skipped, false);
});

test('preflight checks config, services, labels and port without touching Docker', async () => {
  const calls = [];
  const timeouts = [];
  const run = (args, timeoutMs) => {
    calls.push(args);
    timeouts.push(timeoutMs);
    if (args[0] === 'config' && args[1] === '--quiet') {
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'config' && args[1] === '--services') {
      return { status: 0, stdout: `${REQUIRED_SERVICES.join('\n')}\n`, stderr: '' };
    }
    if (args[0] === 'ps') return { status: 0, stdout: '[]', stderr: '' };
    throw new Error(`unexpected compose args: ${args.join(' ')}`);
  };
  const config = { project: DEFAULT_PROJECT, port: 8081 };
  const result = await preflight(config, { run, probe: async () => false });
  assert.deepEqual(result, { entries: [], hasContainers: false });
  assert.deepEqual(calls[0], ['config', '--quiet']);
  assert.deepEqual(timeouts, [30_000, 30_000, 30_000]);

  await assert.rejects(preflight(config, {
    run,
    probe: async () => true,
  }), /already in use/);
  await assert.rejects(preflight(config, {
    run: (args, timeoutMs) => args[0] === 'config' && args[1] === '--services'
      ? { status: 0, stdout: 'api-gateway\n', stderr: '' }
      : run(args, timeoutMs),
    probe: async () => false,
  }), /missing required services/);
});

test('dispatch failure scenario rejects 503 and verifies stock without Pagos', async () => {
  let stockCalls = 0;
  const http = async (path, options = {}) => {
    if (path === '/v1/customers' && options.method === 'POST') {
      return response(201, { id: CUSTOMER_ID });
    }
    if (path === '/v1/orders' && options.method === 'POST') {
      return response(503, {
        code: 'DISPATCH_UNAVAILABLE',
        message: 'Dispatch service is unavailable',
        traceId: TRACE_ID,
      }, { 'x-trace-id': TRACE_ID });
    }
    if (path.startsWith('/v1/orders?customerId=')) {
      return response(200, { page: 1, pageSize: 20, total: 0, items: [] });
    }
    if (path === '/v1/customers') return response(200, []);
    throw new Error(`unexpected request: ${options.method ?? 'GET'} ${path}`);
  };
  const result = await runDispatchFailure({
    config: {},
    http,
    stock: async () => {
      stockCalls += 1;
      return 5;
    },
    run: () => {},
    tokenProvider: (role) => `${role}-token`,
  });
  assert.deepEqual(result, {
    status: 503,
    code: 'DISPATCH_UNAVAILABLE',
    replayStatus: 503,
    replayCode: 'DISPATCH_UNAVAILABLE',
    publicOrders: 0,
    stockBefore: 5,
    stockAfterFirst: 5,
    stockAfter: 5,
    customersStatus: 200,
  });
  assert.equal(stockCalls, 3);
});

test('dispatch failure logs the recovery key and fails on an unexpected 500', async () => {
  const logs = [];
  let stockCalls = 0;
  const http = async (path, options = {}) => {
    if (path === '/v1/customers' && options.method === 'POST') {
      return response(201, { id: CUSTOMER_ID });
    }
    if (path === '/v1/orders' && options.method === 'POST') {
      return response(500, { code: 'INTERNAL_ERROR', message: 'Internal error', traceId: TRACE_ID });
    }
    throw new Error(`unexpected request: ${path}`);
  };
  await assert.rejects(runDispatchFailure({
    config: {},
    http,
    stock: async () => {
      stockCalls += 1;
      return 5;
    },
    run: () => {},
    tokenProvider: (role) => `${role}-token`,
    log: (message) => logs.push(message),
  }), /expected HTTP 503, got 500/);
  assert.equal(stockCalls, 1);
  assert.ok(logs.some((message) => message.includes('Idempotency-Key=')));
});

test('scenario definitions preserve the stock -> stock,dispatch -> failure order', () => {
  const plan = scenarioDefinitions();
  assert.deepEqual(plan.map((scenario) => scenario.name), [
    'stock',
    'stock,dispatch',
    'dispatch-failure',
  ]);
  assert.equal(plan[0].sagaSteps, 'stock');
  assert.deepEqual(plan[1].services, ['sales-api', 'dispatch-api']);
  assert.equal(plan[2].sagaSteps, 'stock,dispatch');
  assert.equal(plan[2].dispatchFailCreate, true);
  assert.deepEqual(plan[2].services, ['dispatch-api']);
});

test('upStack keeps the cleaned Compose env and adds only scenario overrides', async () => {
  let captured;
  await upStack({
    composeEnv: {
      COMPOSE_FILE: '',
      COMPOSE_PROFILES: '',
      COMPOSE_DISABLE_ENV_FILE: '1',
    },
  }, {
    sagaSteps: 'stock',
    dispatchFailCreate: false,
    build: false,
    runUp: async (_config, args, options) => {
      captured = { args, options };
      return { code: 0, timedOut: false };
    },
  });
  assert.deepEqual(captured.args, [
    'up', '-d', '--wait', '--wait-timeout', '300', '--no-build',
  ]);
  assert.equal(captured.options.env.COMPOSE_FILE, '');
  assert.equal(captured.options.env.COMPOSE_PROFILES, '');
  assert.equal(captured.options.env.COMPOSE_DISABLE_ENV_FILE, '1');
  assert.equal(captured.options.env.SAGA_STEPS, 'stock');
  assert.equal(captured.options.env.DISPATCH_FAIL_CREATE, 'false');
});

test('main composes preflight with numeric timeouts and no Docker', async () => {
  const calls = [];
  const composeRun = (args, timeoutMs) => {
    assert.equal(typeof timeoutMs, 'number');
    assert.equal(timeoutMs, 30_000);
    calls.push(args);
    if (args[0] === 'config' && args[1] === '--quiet') {
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'config' && args[1] === '--services') {
      return { status: 0, stdout: `${REQUIRED_SERVICES.join('\n')}\n`, stderr: '' };
    }
    if (args[0] === 'ps') return { status: 0, stdout: '[]', stderr: '' };
    throw new Error(`unexpected compose args: ${args.join(' ')}`);
  };

  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  let stdout = '';
  let stderr = '';
  process.stdout.write = (chunk) => { stdout += String(chunk); return true; };
  process.stderr.write = (chunk) => { stderr += String(chunk); return true; };
  let report;
  try {
    report = await main({
      argv: ['--no-build'],
      env: {
        PATH: process.env.PATH,
        P4_TEST_PROJECT: 'repuestossur-p4-test',
        P4_TEST_PORT: '8082',
      },
      deps: {
        exists: () => false,
        probe: async () => false,
        composeRun,
        scenarios: {
          http: async () => ({ status: 200, json: { service: 'gateway' } }),
          stock: async () => 5,
          smoke: async () => {},
          up: async () => {},
          dispatchFailure: async () => ({
            status: 503,
            code: 'DISPATCH_UNAVAILABLE',
            replayStatus: 503,
            replayCode: 'DISPATCH_UNAVAILABLE',
            publicOrders: 0,
            stockBefore: 5,
            stockAfterFirst: 5,
            stockAfter: 5,
            customersStatus: 200,
          }),
        },
        restore: {
          up: async () => {},
          readEnv: (service) => service === 'sales-api' ? 'stock,dispatch' : 'false',
        },
      },
    });
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }

  assert.equal(report.status, 'passed');
  assert.equal(report.modes.length, 3);
  assert.deepEqual(report.restore, {
    sagaSteps: 'stock,dispatch',
    dispatchFailCreate: 'false',
    verified: true,
  });
  assert.deepEqual(calls, [
    ['config', '--quiet'],
    ['config', '--services'],
    ['ps', '--all', '--format', 'json'],
  ]);
  assert.equal(JSON.parse(stdout.trim()).status, 'passed');
  assert.match(stderr, /\[scenario 1\]/);
});

test('runSmoke scopes the child env and strips caller tokens', () => {
  let captured;
  const baseEnv = {
    COMPOSE_FILE: '/tmp/evil.yml',
    COMPOSE_PROFILES: 'experiment',
    COMPOSE_DISABLE_ENV_FILE: '0',
    GATEWAY_READER_TOKEN: 'caller-reader',
    GATEWAY_OPERATOR_TOKEN: 'caller-operator',
  };
  const composeEnv = buildComposeEnv({
    project: 'repuestossur-p4-test',
    port: 8081,
    envFile: '/repo/.env.p4',
  }, baseEnv);
  const result = runSmoke({
    baseUrl: 'http://127.0.0.1:8081',
    repoRoot: '/repo',
    composeEnv,
  }, 'stock,dispatch', {
    run: (command, args, options) => {
      captured = { command, args, options };
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.deepEqual(result, { mode: 'stock,dispatch', status: 0 });
  assert.equal(captured.command, process.execPath);
  assert.deepEqual(captured.args, ['tests/t2/p4-smoke.mjs']);
  assert.equal(captured.options.env.GATEWAY_BASE_URL, 'http://127.0.0.1:8081');
  assert.equal(captured.options.env.P4_SMOKE_EXPECT_STEPS, 'stock,dispatch');
  assert.equal(captured.options.env.P4_SMOKE_DISPATCH_FIXTURE, 'false');
  assert.equal(captured.options.env.COMPOSE_PROJECT_NAME, 'repuestossur-p4-test');
  assert.equal(captured.options.env.COMPOSE_FILE, '');
  assert.equal(captured.options.env.COMPOSE_PROFILES, '');
  assert.equal(captured.options.env.COMPOSE_ENV_FILES, '/repo/.env.p4');
  assert.equal(captured.options.env.COMPOSE_DISABLE_ENV_FILE, '0');
  assert.equal(captured.options.env.GATEWAY_READER_TOKEN, undefined);
  assert.equal(captured.options.env.GATEWAY_OPERATOR_TOKEN, undefined);
  assert.equal(captured.options.cwd, '/repo');
  assert.deepEqual(baseEnv, {
    COMPOSE_FILE: '/tmp/evil.yml',
    COMPOSE_PROFILES: 'experiment',
    COMPOSE_DISABLE_ENV_FILE: '0',
    GATEWAY_READER_TOKEN: 'caller-reader',
    GATEWAY_OPERATOR_TOKEN: 'caller-operator',
  });
});

test('runScenarios executes the three modes in order with scoped recreation', async () => {
  const calls = [];
  const state = { modes: [], failure: null };
  const result = await runScenarios({
    baseUrl: 'http://127.0.0.1:8081',
    build: false,
    composeEnv: {},
  }, {
    http: async () => ({ status: 200, json: { service: 'gateway' } }),
    stock: async () => 5,
    smoke: async (mode) => { calls.push(`smoke:${mode}`); },
    up: async (options) => {
      calls.push([
        'up',
        options.sagaSteps,
        String(options.dispatchFailCreate),
        options.services?.join('+') ?? 'all',
        String(options.forceRecreate ?? false),
      ].join(':'));
    },
    dispatchFailure: async () => ({
      status: 503,
      code: 'DISPATCH_UNAVAILABLE',
      replayStatus: 503,
      replayCode: 'DISPATCH_UNAVAILABLE',
      publicOrders: 0,
      stockBefore: 5,
      stockAfterFirst: 5,
      stockAfter: 5,
      customersStatus: 200,
    }),
    state,
    log: () => {},
  });
  assert.deepEqual(calls, [
    'up:stock:false:all:false',
    'smoke:stock',
    'up:stock,dispatch:false:sales-api+dispatch-api:true',
    'smoke:stock,dispatch',
    'up:stock,dispatch:true:dispatch-api:true',
  ]);
  assert.equal(result.modes.length, 3);
  assert.equal(result.failure.code, 'DISPATCH_UNAVAILABLE');
  assert.equal(result.modes[2].stockBefore, 5);
});
