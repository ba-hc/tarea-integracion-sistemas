import http from 'k6/http';
import { Counter } from 'k6/metrics';

// RS-402 - Escenario de carga para el experimento de timeout.
//
// Mide la latencia y los codigos de respuesta observados por el llamador de
// POST /v1/orders mientras Toxiproxy inyecta latencia en el salto
// Sales -> Inventory. El metodo completo esta en ../README.md.

const BASE_URL = __ENV.SALES_BASE_URL;
const API_KEY = __ENV.SALES_API_KEY;
const PART_ID = __ENV.EXPERIMENT_PART_ID;
const CUSTOMER_ID = __ENV.EXPERIMENT_CUSTOMER_ID;

const RATE = Number(__ENV.RATE || 5);
const DURATION = __ENV.DURATION || '30s';

if (!BASE_URL || !API_KEY || !PART_ID || !CUSTOMER_ID) {
  throw new Error(
    'Faltan variables de entorno: SALES_BASE_URL, SALES_API_KEY, EXPERIMENT_PART_ID, EXPERIMENT_CUSTOMER_ID'
  );
}

const status201 = new Counter('status_201');
const status409 = new Counter('status_409');
const status503 = new Counter('status_503');
const status504 = new Counter('status_504');
const statusOther = new Counter('status_other');

export const options = {
  scenarios: {
    // constant-arrival-rate y no VUs constantes: mantiene fija la carga
    // ofrecida aunque la latencia crezca. Con VUs constantes el throughput
    // caeria al subir la latencia y no podriamos separar causa de efecto.
    measure: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 50,
      maxVUs: 300,
    },
  },
  // Por defecto k6 no calcula p(50) ni p(99); hay que pedirlos explicitamente.
  summaryTrendStats: ['min', 'avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
  // Sin thresholds: un 504 es un resultado valido del experimento, no un fallo.
  thresholds: {},
};

export default function () {
  const payload = JSON.stringify({
    customerId: CUSTOMER_ID,
    items: [{ partId: PART_ID, quantity: 1 }],
  });

  const res = http.post(`${BASE_URL}/v1/orders`, payload, {
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
      // Unica por iteracion, para que ninguna respuesta sea un replay de
      // idempotencia. Formato ^[A-Za-z0-9._:-]+$ de 8 a 128 caracteres,
      // segun contracts/rest/openapi.yaml.
      'Idempotency-Key': `exp-${__VU}-${__ITER}-${Date.now()}`,
    },
    // El corte lo decide el deadline de Sales, no el cliente.
    timeout: '120s',
  });

  if (res.status === 201) {
    status201.add(1);
  } else if (res.status === 409) {
    status409.add(1);
  } else if (res.status === 503) {
    status503.add(1);
  } else if (res.status === 504) {
    status504.add(1);
  } else {
    statusOther.add(1);
  }
}

function metric(data, name, key) {
  const m = data.metrics[name];
  if (!m || m.values[key] === undefined || m.values[key] === null) {
    return 0;
  }
  return m.values[key];
}

function ms(value) {
  return Math.round(value * 100) / 100;
}

// Emite una fila CSV por corrida. run.sh las concatena en results/summary.csv,
// de modo que el pipeline no necesita jq ni ninguna otra dependencia.
export function handleSummary(data) {
  const row = [
    __ENV.RUN_DEADLINE_MS || '',
    __ENV.RUN_LATENCY_MS || '',
    __ENV.RUN_REP || '',
    RATE,
    DURATION,
    metric(data, 'http_reqs', 'count'),
    ms(metric(data, 'http_reqs', 'rate')),
    metric(data, 'status_201', 'count'),
    metric(data, 'status_409', 'count'),
    metric(data, 'status_503', 'count'),
    metric(data, 'status_504', 'count'),
    metric(data, 'status_other', 'count'),
    ms(metric(data, 'http_req_duration', 'p(50)')),
    ms(metric(data, 'http_req_duration', 'p(95)')),
    ms(metric(data, 'http_req_duration', 'p(99)')),
    ms(metric(data, 'http_req_duration', 'max')),
  ].join(',');

  const out = { stdout: `${row}\n` };
  if (__ENV.SUMMARY_JSON) {
    out[__ENV.SUMMARY_JSON] = JSON.stringify(data, null, 2);
  }
  if (__ENV.SUMMARY_CSV) {
    out[__ENV.SUMMARY_CSV] = `${row}\n`;
  }
  return out;
}
