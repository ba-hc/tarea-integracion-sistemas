#!/usr/bin/env bash
# RS-402 - Control del toxic de latencia de Toxiproxy sobre el salto
# Sales -> Inventory.
#
# Uso:
#   ./toxic.sh ensure        crea el proxy si todavia no existe
#   ./toxic.sh set 750       aplica 750 ms de latencia inyectada
#   ./toxic.sh clear         elimina el toxic (condicion de 0 ms)
#   ./toxic.sh show          muestra el estado actual del proxy

set -euo pipefail

TOXIPROXY_API="${TOXIPROXY_API:-http://localhost:8474}"
PROXY_NAME="${PROXY_NAME:-inventory}"
PROXY_LISTEN="${PROXY_LISTEN:-0.0.0.0:50051}"
PROXY_UPSTREAM="${PROXY_UPSTREAM:-inventory-grpc:50051}"
TOXIC_NAME="latency_downstream"

usage() {
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

ensure_proxy() {
  # 201 al crearlo, 409 si ya existia: ambos son exito para nosotros.
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' \
    -X POST "$TOXIPROXY_API/proxies" \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"$PROXY_NAME\",\"listen\":\"$PROXY_LISTEN\",\"upstream\":\"$PROXY_UPSTREAM\",\"enabled\":true}")

  case "$code" in
    201|409) echo "proxy '$PROXY_NAME' listo ($PROXY_LISTEN -> $PROXY_UPSTREAM)" ;;
    *) echo "error: Toxiproxy respondio $code al crear el proxy '$PROXY_NAME'" >&2; exit 1 ;;
  esac
}

clear_toxic() {
  # 204 al borrarlo, 404 si no habia toxic: ambos dejan el proxy limpio.
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' \
    -X DELETE "$TOXIPROXY_API/proxies/$PROXY_NAME/toxics/$TOXIC_NAME")

  case "$code" in
    204|404) ;;
    *) echo "error: Toxiproxy respondio $code al borrar el toxic" >&2; exit 1 ;;
  esac
}

set_toxic() {
  local latency_ms="$1"

  clear_toxic

  # 0 ms es la condicion de control: se mide sin toxic, no con un toxic de 0.
  if [ "$latency_ms" -eq 0 ]; then
    echo "latencia inyectada: 0 ms (sin toxic)"
    return
  fi

  # jitter 0: queremos una latencia determinista, no una distribucion.
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' \
    -X POST "$TOXIPROXY_API/proxies/$PROXY_NAME/toxics" \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"$TOXIC_NAME\",\"type\":\"latency\",\"stream\":\"downstream\",\"toxicity\":1.0,\"attributes\":{\"latency\":$latency_ms,\"jitter\":0}}")

  if [ "$code" != "200" ]; then
    echo "error: Toxiproxy respondio $code al aplicar el toxic de $latency_ms ms" >&2
    exit 1
  fi
  echo "latencia inyectada: ${latency_ms} ms"
}

case "${1:-}" in
  ensure) ensure_proxy ;;
  set)    [ $# -eq 2 ] || usage; set_toxic "$2" ;;
  clear)  clear_toxic; echo "toxic eliminado" ;;
  show)   curl -sS "$TOXIPROXY_API/proxies/$PROXY_NAME"; echo ;;
  *)      usage ;;
esac
