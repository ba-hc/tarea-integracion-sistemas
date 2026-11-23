// T2-203 - Carga sobre Pagos con la pasarela normal, lenta o caída.
//
// Corre dentro de la red de Compose (servicio k6-payments). Tres escenarios a la vez:
// - charges: cobros nuevos a tasa constante (cada iteración es una venta distinta).
// - reads:   consultas GET de un cobro existente: ¿siguen respondiendo otras operaciones?
// - probe:   lee /internal/v1/resilience dos veces por segundo y emite una línea
//            TIMELINE con el estado del circuito y del bulkhead.
//
// El plazo del cliente (CLIENT_TIMEOUT, 2 s) es el mismo que usa Ventas con Pagos,
// así que la latencia medida es la que vería la Saga.

import http from 'k6/http';
import exec from 'k6/execution';
import { Counter, Trend } from 'k6/metrics';

const PAYMENTS_URL = __ENV.PAYMENTS_URL || 'http://payments-api:3003';
const RATE = Number(__ENV.RATE || 20);
const READ_RATE = Number(__ENV.READ_RATE || 5);
const DURATION = __ENV.DURATION || '30s';
const CLIENT_TIMEOUT = __ENV.CLIENT_TIMEOUT || '2s';
const READ_ORDER_ID = __ENV.READ_ORDER_ID;
const AMOUNT_MINOR = 10000;

if (!READ_ORDER_ID) throw new Error('READ_ORDER_ID is required (an order already charged)');

const chargeMs = new Trend('charge_ms', true);
const fallbackMs = new Trend('charge_fallback_ms', true);
const readMs = new Trend('read_ms', true);
const outcomes = {
  charged: new Counter('charge_charged'),
  pending: new Counter('charge_pending'),
  rejected: new Counter('charge_fallback_rejected'),
  declined: new Counter('charge_declined'),
  timeout: new Counter('charge_client_timeout'),
  error: new Counter('charge_other_error'),
};
const readErrors = new Counter('read_errors');

export const options = {
  discardResponseBodies: false,
  summaryTrendStats: ['count', 'avg', 'min', 'med', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    charges: {
      executor: 'constant-arrival-rate',
      exec: 'charge',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 60,
      maxVUs: 300,
    },
    reads: {
      executor: 'constant-arrival-rate',
      exec: 'read',
      rate: READ_RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 5,
      maxVUs: 50,
    },
    probe: {
      executor: 'constant-arrival-rate',
      exec: 'probe',
      rate: 2,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 2,
      maxVUs: 5,
    },
  },
};

function uuidv4() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function jsonField(response, field) {
  try {
    return response.json(field);
  } catch {
    return undefined;
  }
}

export function charge() {
  const response = http.put(
    `${PAYMENTS_URL}/internal/v1/payments/${uuidv4()}`,
    JSON.stringify({ amountMinor: AMOUNT_MINOR, currency: 'CLP' }),
    { headers: { 'content-type': 'application/json' }, timeout: CLIENT_TIMEOUT, tags: { name: 'charge' } },
  );
  const duration = response.timings.duration;
  chargeMs.add(duration);
  if ((response.status === 200 || response.status === 201) && jsonField(response, 'status') === 'CHARGED') {
    outcomes.charged.add(1);
  } else if (response.status === 202) {
    outcomes.pending.add(1);
  } else if (response.status === 503 && jsonField(response, 'code') === 'PAYMENT_CHARGE_REJECTED') {
    outcomes.rejected.add(1);
    fallbackMs.add(duration);
  } else if (response.status === 422) {
    outcomes.declined.add(1);
  } else if (response.status === 0) {
    outcomes.timeout.add(1);
  } else {
    outcomes.error.add(1);
  }
}

export function read() {
  const response = http.get(`${PAYMENTS_URL}/internal/v1/payments/${READ_ORDER_ID}`, {
    timeout: CLIENT_TIMEOUT,
    tags: { name: 'read' },
  });
  readMs.add(response.timings.duration);
  if (response.status !== 200) readErrors.add(1);
}

export function probe() {
  const response = http.get(`${PAYMENTS_URL}/internal/v1/resilience`, { timeout: '1s', tags: { name: 'probe' } });
  if (response.status !== 200) return;
  const snapshot = response.json();
  const elapsedMs = Date.now() - exec.scenario.startTime;
  console.log([
    'TIMELINE',
    elapsedMs,
    snapshot.circuitBreaker.state,
    snapshot.circuitBreaker.rejectedCalls,
    snapshot.circuitBreaker.openedCount,
    snapshot.bulkhead.inFlight,
    snapshot.bulkhead.rejectedCalls,
  ].join(','));
}

function metric(data, name, stat) {
  const values = data.metrics[name] && data.metrics[name].values;
  if (!values) return 0;
  const value = values[stat];
  return typeof value === 'number' ? Math.round(value * 10) / 10 : 0;
}

export function handleSummary(data) {
  const summary = {
    rateRps: RATE,
    readRateRps: READ_RATE,
    duration: DURATION,
    clientTimeout: CLIENT_TIMEOUT,
    charge: {
      requests: metric(data, 'charge_ms', 'count'),
      charged: metric(data, 'charge_charged', 'count'),
      pending: metric(data, 'charge_pending', 'count'),
      fallbackRejected: metric(data, 'charge_fallback_rejected', 'count'),
      declined: metric(data, 'charge_declined', 'count'),
      clientTimeouts: metric(data, 'charge_client_timeout', 'count'),
      otherErrors: metric(data, 'charge_other_error', 'count'),
      p50Ms: metric(data, 'charge_ms', 'med'),
      p95Ms: metric(data, 'charge_ms', 'p(95)'),
      p99Ms: metric(data, 'charge_ms', 'p(99)'),
      maxMs: metric(data, 'charge_ms', 'max'),
      fallbackP95Ms: metric(data, 'charge_fallback_ms', 'p(95)'),
    },
    read: {
      requests: metric(data, 'read_ms', 'count'),
      errors: metric(data, 'read_errors', 'count'),
      p95Ms: metric(data, 'read_ms', 'p(95)'),
      maxMs: metric(data, 'read_ms', 'max'),
    },
    droppedIterations: metric(data, 'dropped_iterations', 'count'),
  };
  return { stdout: `${JSON.stringify(summary)}\n` };
}
