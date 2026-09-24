#!/usr/bin/env bash
# RS-402 - Barrido de latencia inyectada para un brazo del experimento.
#
# Ejecuta un brazo completo (un valor de INVENTORY_RPC_DEADLINE_MS) sobre todas
# las condiciones de latencia, repitiendo cada una REPS veces, y deja los
# resultados en results/.
#
# El deadline NO lo cambia este script: se configura en el stack antes de
# levantarlo y aqui solo se declara, via DEADLINE_MS, para etiquetar las filas.
# Ver ../README.md.

set -euo pipefail

EXP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$EXP_DIR"

SALES_BASE_URL="${SALES_BASE_URL:-http://localhost:3000}"
SALES_API_KEY="${SALES_API_KEY:-}"
EXPERIMENT_PART_ID="${EXPERIMENT_PART_ID:-}"
DEADLINE_MS="${DEADLINE_MS:-}"

LATENCIES="${LATENCIES:-0 250 500 750 1000 1500}"
REPS="${REPS:-3}"
RATE="${RATE:-20}"
DURATION="${DURATION:-30s}"
WARMUP="${WARMUP:-5s}"

RUNS_DIR="results/runs"
SUMMARY_CSV="results/summary.csv"
CSV_HEADER="deadline_ms,injected_latency_ms,rep,rate_rps,duration,http_reqs,rps_actual,status_201,status_409,status_503,status_504,status_other,p50_ms,p95_ms,p99_ms,max_ms"

die() { echo "error: $*" >&2; exit 1; }

[ -n "$SALES_API_KEY" ]      || die "falta SALES_API_KEY (debe ser una key con rol operator)"
[ -n "$EXPERIMENT_PART_ID" ] || die "falta EXPERIMENT_PART_ID (la pieza sembrada con stock alto)"
[ -n "$DEADLINE_MS" ]        || die "falta DEADLINE_MS (el deadline con el que esta levantado Sales)"
command -v k6 >/dev/null 2>&1   || die "k6 no esta instalado; ver README"
command -v curl >/dev/null 2>&1 || die "curl no esta instalado"

mkdir -p "$RUNS_DIR"

echo "==> Verificando que Sales responda en $SALES_BASE_URL"
curl -sS -f "$SALES_BASE_URL/v1/health" >/dev/null \
  || die "Sales no responde en $SALES_BASE_URL/v1/health; levanta el stack primero"

echo "==> Preparando el proxy de Inventory"
./scripts/toxic.sh ensure

# Cliente dedicado del experimento. Se crea aqui para no depender del seed de
# Sales; el email lleva timestamp porque es unico por contrato.
echo "==> Creando el cliente del experimento"
customer_response=$(curl -sS -f \
  -X POST "$SALES_BASE_URL/v1/customers" \
  -H 'Content-Type: application/json' \
  -H "X-API-Key: $SALES_API_KEY" \
  -d "{\"name\":\"Experimento RS-402\",\"email\":\"rs402-$(date +%s)@repuestossur.test\"}")

EXPERIMENT_CUSTOMER_ID=$(printf '%s' "$customer_response" \
  | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
[ -n "$EXPERIMENT_CUSTOMER_ID" ] || die "no se pudo extraer el id del cliente: $customer_response"
echo "    customerId=$EXPERIMENT_CUSTOMER_ID"

run_k6() {
  local duration="$1" summary_json="$2" summary_csv="$3"
  k6 run --quiet \
    -e SALES_BASE_URL="$SALES_BASE_URL" \
    -e SALES_API_KEY="$SALES_API_KEY" \
    -e EXPERIMENT_PART_ID="$EXPERIMENT_PART_ID" \
    -e EXPERIMENT_CUSTOMER_ID="$EXPERIMENT_CUSTOMER_ID" \
    -e RATE="$RATE" \
    -e DURATION="$duration" \
    -e RUN_DEADLINE_MS="$DEADLINE_MS" \
    -e RUN_LATENCY_MS="$latency" \
    -e RUN_REP="$rep" \
    -e SUMMARY_JSON="$summary_json" \
    -e SUMMARY_CSV="$summary_csv" \
    k6/create-order.js
}

for latency in $LATENCIES; do
  echo "==> Condicion: ${latency} ms de latencia inyectada"
  ./scripts/toxic.sh set "$latency"

  for rep in $(seq 1 "$REPS"); do
    run_id=$(printf 'd%s_l%05d_r%s' "$DEADLINE_MS" "$latency" "$rep")

    # Warm-up descartado: no escribe archivos, solo calienta conexiones y pool.
    run_k6 "$WARMUP" "" "" >/dev/null

    echo "    rep $rep/$REPS"
    run_k6 "$DURATION" "$RUNS_DIR/$run_id.json" "$RUNS_DIR/$run_id.csv" >/dev/null

    # Un 409 significa stock agotado o colision de idempotencia: la corrida ya
    # no mide lo que creemos que mide, asi que se corta en vez de guardarla.
    conflicts=$(cut -d, -f9 "$RUNS_DIR/$run_id.csv")
    if [ "${conflicts:-0}" -gt 0 ]; then
      ./scripts/toxic.sh clear
      die "la corrida $run_id devolvio $conflicts respuestas 409. Resiembra el stock de $EXPERIMENT_PART_ID y repite el brazo; los resultados parciales quedan en $RUNS_DIR"
    fi
  done
done

echo "==> Limpiando el toxic"
./scripts/toxic.sh clear

echo "==> Consolidando $SUMMARY_CSV"
{
  echo "$CSV_HEADER"
  cat "$RUNS_DIR"/*.csv
} > "$SUMMARY_CSV"

echo
echo "Listo. Brazo deadline=${DEADLINE_MS}ms completado."
echo "  filas: $SUMMARY_CSV"
echo "  crudo: $RUNS_DIR/"
