#!/usr/bin/env bash
# RS-401 - Criterio "Docker" de docs/architecture/TEST-MATRIX.md:
# desde un estado limpio, 'docker compose up --build' debe bastar para iniciar
# todos los servicios obligatorios.
#
# Es lo unico que la suite de Vitest no puede cubrir: esas pruebas asumen un stack
# ya levantado, y aqui lo que se verifica es justamente el arranque desde cero.
#
#   bash tests/system/check-stack.sh
#
# Destruye los volumenes locales ('down -v'), que es lo que significa "estado
# limpio". No ejecutarlo sobre datos que importen.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# T2: el unico puerto publicado es el del API Gateway; /v1/health pasa por el.
BASE_URL="${GATEWAY_BASE_URL:-http://127.0.0.1:${GATEWAY_PUBLISHED_PORT:-8080}}"
# Los perfiles 'experiment', 'test' y 'payments-experiment' quedan fuera a proposito.
REQUIRED_SERVICES="sales-db inventory-db dispatch-db payments-db inventory-grpc sales-api dispatch-api payment-gateway-sim payments-api web-bff api-gateway"

echo "==> Estado limpio"
unset COMPOSE_FILE COMPOSE_PROFILES
docker compose down -v --remove-orphans

echo "==> docker compose up --build"
# --wait respeta los healthcheck, asi que falla si algun servicio no queda sano.
docker compose up --build -d --wait

echo "==> Servicios obligatorios en ejecucion"
running="$(docker compose ps --services --status running)"
for service in $REQUIRED_SERVICES; do
  if ! printf '%s\n' "$running" | grep -qx "$service"; then
    echo "FALLO: el servicio '$service' no quedo en ejecucion." >&2
    echo "       En ejecucion: $(printf '%s ' $running)" >&2
    exit 1
  fi
  echo "    $service"
done

echo "==> GET /v1/health responde sin token a traves del Gateway"
status="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/v1/health")"
if [ "$status" != "200" ]; then
  echo "FALLO: GET $BASE_URL/v1/health devolvio $status, se esperaba 200." >&2
  exit 1
fi

echo
echo "OK: un solo 'docker compose up --build' dejo el stack operativo desde cero."
