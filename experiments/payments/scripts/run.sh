#!/usr/bin/env bash
# T2-203 - Experimento de Pagos bajo carga, con y sin protecciones.
#
# Para cada brazo (protected | unprotected), escenario de la pasarela
# (normal | slow | down) y repetición:
#   1. recrea payments-api con la configuración del brazo (estado del circuito limpio);
#   2. siembra un cobro para el escenario de lecturas;
#   3. pone la pasarela simulada en el modo del escenario;
#   4. corre k6 (servicio k6-payments, dentro de la red de Compose);
#   5. guarda resumen, línea de tiempo del circuito y métricas de Pagos y de la pasarela.
#
# Requisitos: Docker Compose y Node.js en el host (sólo para leer los JSON).
# Uso, desde la raíz del repositorio:
#   bash experiments/payments/scripts/run.sh
# Variables: ARMS, SCENARIOS, REPS, RATE, READ_RATE, DURATION, SLOW_DELAY_MS.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
EXP_DIR="$ROOT_DIR/experiments/payments"
cd "$ROOT_DIR"

ARMS="${ARMS:-protected unprotected}"
SCENARIOS="${SCENARIOS:-normal slow down}"
REPS="${REPS:-3}"
RATE="${RATE:-20}"
READ_RATE="${READ_RATE:-5}"
DURATION="${DURATION:-30s}"
SLOW_DELAY_MS="${SLOW_DELAY_MS:-3000}"
CLIENT_TIMEOUT="${CLIENT_TIMEOUT:-2s}"

RUNS_DIR="$EXP_DIR/results/runs"
SUMMARY_CSV="$EXP_DIR/results/summary.csv"
CSV_HEADER="timestamp,arm,scenario,rep,rate_rps,duration,client_timeout,charge_requests,charged,pending,fallback_rejected,declined,client_timeouts,other_errors,charge_p50_ms,charge_p95_ms,charge_p99_ms,charge_max_ms,fallback_p95_ms,read_requests,read_errors,read_p95_ms,read_max_ms,dropped_iterations,circuit_opened,circuit_rejected,bulkhead_rejected,bulkhead_peak,gateway_calls,gateway_charges_applied"

die() { echo "error: $*" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || die "docker no está instalado"
command -v node >/dev/null 2>&1 || die "node no está instalado (se usa para leer los resúmenes JSON)"

compose() { docker compose "$@"; }

# Ejecuta fetch() dentro de un contenedor del stack; imprime el cuerpo JSON.
in_container() {
  local service="$1" method="$2" url="$3" body="${4:-}"
  compose exec -T "$service" node -e '
    const [method, url, body] = process.argv.slice(1);
    const init = { method, signal: AbortSignal.timeout(5000) };
    if (body) { init.body = body; init.headers = { "content-type": "application/json" }; }
    fetch(url, init).then(async (r) => { const t = await r.text(); process.stdout.write(t); process.exit(r.ok ? 0 : 1); })
      .catch((e) => { console.error(e.message); process.exit(1); });
  ' "$method" "$url" "$body"
}

sim() { in_container payment-gateway-sim "$@"; }
set_mode() { sim PUT http://127.0.0.1:3010/admin/config "{\"mode\":\"$1\",\"slowDelayMs\":$SLOW_DELAY_MS}" >/dev/null; }

json() { node -e 'const v = JSON.parse(process.argv[1]); const path = process.argv[2].split("."); let x = v; for (const p of path) x = x?.[p]; process.stdout.write(String(x ?? 0));' "$1" "$2"; }

arm_env() {
  case "$1" in
    protected)   echo "PAYMENTS_CIRCUIT_BREAKER_ENABLED=true PAYMENTS_BULKHEAD_ENABLED=true PAYMENTS_GATEWAY_TIMEOUT_MS=1200" ;;
    unprotected) echo "PAYMENTS_CIRCUIT_BREAKER_ENABLED=false PAYMENTS_BULKHEAD_ENABLED=false PAYMENTS_GATEWAY_TIMEOUT_MS=30000" ;;
    *) die "brazo desconocido: $1" ;;
  esac
}

mkdir -p "$RUNS_DIR"
[ -f "$SUMMARY_CSV" ] || echo "$CSV_HEADER" > "$SUMMARY_CSV"
[ "$(head -n1 "$SUMMARY_CSV")" = "$CSV_HEADER" ] || die "$SUMMARY_CSV tiene otra cabecera; muévelo antes de continuar"

echo "==> Levantando Pagos y la pasarela simulada"
compose up --build -d --wait payments-db payment-gateway-sim payments-api

for arm in $ARMS; do
  for scenario in $SCENARIOS; do
    for rep in $(seq 1 "$REPS"); do
      run_id="${arm}_${scenario}_r${rep}"
      echo "==> $run_id"

      # shellcheck disable=SC2046
      env $(arm_env "$arm") docker compose up -d --wait --force-recreate --no-deps payments-api >/dev/null

      set_mode normal
      read_order_id="$(node -e 'console.log(crypto.randomUUID())')"
      in_container payments-api PUT "http://127.0.0.1:3003/internal/v1/payments/$read_order_id" '{"amountMinor":10000,"currency":"CLP"}' >/dev/null \
        || die "no se pudo sembrar el cobro de lectura"

      set_mode "$scenario"
      sim_before="$(sim GET http://127.0.0.1:3010/admin/config)"

      compose --profile payments-experiment run --rm --no-deps \
        -e RATE="$RATE" -e READ_RATE="$READ_RATE" -e DURATION="$DURATION" -e CLIENT_TIMEOUT="$CLIENT_TIMEOUT" \
        -e READ_ORDER_ID="$read_order_id" \
        k6-payments run --quiet --log-format raw k6/payments-load.js > "$RUNS_DIR/${run_id}.log" 2>&1 \
        || die "k6 falló en $run_id; ver $RUNS_DIR/${run_id}.log"

      sim_after="$(sim GET http://127.0.0.1:3010/admin/config)"
      resilience="$(in_container payments-api GET http://127.0.0.1:3003/internal/v1/resilience)"
      set_mode normal
      printf '%s\n' "$resilience" > "$RUNS_DIR/${run_id}_resilience.json"
      { echo "elapsed_ms,circuit_state,circuit_rejected,circuit_opened,bulkhead_in_flight,bulkhead_rejected"
        grep '^TIMELINE,' "$RUNS_DIR/${run_id}.log" | cut -d, -f2- | sort -t, -k1,1n; } > "$RUNS_DIR/${run_id}_timeline.csv"
      summary="$(grep '^{' "$RUNS_DIR/${run_id}.log" | tail -n1)"
      [ -n "$summary" ] || die "k6 no dejó resumen en $RUNS_DIR/${run_id}.log"
      printf '%s\n' "$summary" > "$RUNS_DIR/${run_id}.json"
      rm "$RUNS_DIR/${run_id}.log"
      gateway_calls=$(( $(json "$sim_after" stats.apiRequests) - $(json "$sim_before" stats.apiRequests) ))
      charges_applied=$(( $(json "$sim_after" stats.chargesApproved) - $(json "$sim_before" stats.chargesApproved) ))
      row="$(date -u +%Y-%m-%dT%H:%M:%SZ),$arm,$scenario,$rep,$RATE,$DURATION,$CLIENT_TIMEOUT"
      for field in charge.requests charge.charged charge.pending charge.fallbackRejected charge.declined charge.clientTimeouts \
        charge.otherErrors charge.p50Ms charge.p95Ms charge.p99Ms charge.maxMs charge.fallbackP95Ms \
        read.requests read.errors read.p95Ms read.maxMs droppedIterations; do
        row="$row,$(json "$summary" "$field")"
      done
      for field in circuitBreaker.openedCount circuitBreaker.rejectedCalls bulkhead.rejectedCalls bulkhead.peakInFlight; do
        row="$row,$(json "$resilience" "$field")"
      done
      echo "$row,$gateway_calls,$charges_applied" >> "$SUMMARY_CSV"
      echo "    $(tail -n1 "$SUMMARY_CSV")"
    done
  done
done

echo "==> Restaurando Pagos con la configuración por defecto"
docker compose up -d --wait --force-recreate --no-deps payments-api >/dev/null
echo "Resultados en $SUMMARY_CSV"
