# Demo P4 — Gateway, BFF y continuidad

Guion corto para una demo en vivo. No graba vídeo ni modifica el video preexistente. Los comandos se
ejecutan desde la raíz del repositorio.

## Antes de empezar

- Stack full ya levantado: `SAGA_STEPS=stock,payment,dispatch`, `DISPATCH_FAIL_CREATE=false`.
- Proyecto `repuestossur-p4-final`, Gateway en `http://127.0.0.1:8082`, 11 servicios healthy.
- Pagos es el servicio real de P2; `payment-gateway-sim` es la pasarela externa simulada oficial. No
  hay dinero real.
- Simulador en `normal`, Pagos con Circuit Breaker/Bulkhead `true`, cap `8` y timeout `1200 ms`.
- Secretos exportados o `.env.p4` con permisos restrictivos. No imprimas tokens ni claves.
- `curl` y `jq` disponibles en la terminal.
- Ejecuta la demo en exclusiva: sin smoke, carga ni otro proyecto en paralelo.

```bash
export COMPOSE_PROJECT_NAME=repuestossur-p4-final
export COMPOSE_ENV_FILES=.env.p4
export P4_GATEWAY_PUBLISHED_PORT=8082

curl -fsS http://127.0.0.1:8082/health | jq .
curl -fsS http://127.0.0.1:8082/v1/health | jq .
docker compose -f docker-compose.yml -f docker-compose.p4.yml ps \
  --format 'table {{.Service}}\t{{.Status}}'
```

Si no usas `.env.p4`, omite `COMPOSE_ENV_FILES` y exporta los secretos en la terminal.

## 1. Éxito y cancelación

Genera tokens dentro de variables; no se muestran:

```bash
OPERATOR_TOKEN="$(docker compose -f docker-compose.yml -f docker-compose.p4.yml exec -T api-gateway \
  node dist/src/cli/token.js --sub demo-p4-operator --role operator)"
READER_TOKEN="$(docker compose -f docker-compose.yml -f docker-compose.p4.yml exec -T api-gateway \
  node dist/src/cli/token.js --sub demo-p4-reader --role reader)"

PART_ID=e58e2904-9db7-4c8d-8f36-7107e863a268
DEMO_KEY="demo-p4-$(date +%s)"
```

Crea el cliente y la venta. El ID queda en una variable, no se imprime:

```bash
CUSTOMER_ID="$(curl -fsS -X POST http://127.0.0.1:8082/v1/customers \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"Demo P4\",\"email\":\"demo-p4-$(date +%s)@example.invalid\"}" | jq -r .id)"

ORDER_ID="$(curl -fsS -X POST http://127.0.0.1:8082/v1/orders \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Idempotency-Key: $DEMO_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"$CUSTOMER_ID\",\"items\":[{\"partId\":\"$PART_ID\",\"quantity\":1}]}" \
  | jq -r .id)"
```

Muestra el estado sin exponer IDs:

```bash
curl -fsS http://127.0.0.1:8082/v1/orders/$ORDER_ID \
  -H "Authorization: Bearer $READER_TOKEN" | jq '{status}'

curl -fsS http://127.0.0.1:8082/web/v1/orders/$ORDER_ID/summary \
  -H "Authorization: Bearer $READER_TOKEN" \
  | jq '{partial, payment: (.payment.availability + ":" + (.payment.data.status // "-")), dispatch: (.dispatch.availability + ":" + (.dispatch.data.status // "-"))}'
```

Esperado: orden `CONFIRMED`; resumen `partial:false`, pago `available:CHARGED` y despacho
`available:CREATED`.

Cancela dos veces para mostrar idempotencia y reembolso:

```bash
curl -fsS -X POST http://127.0.0.1:8082/v1/orders/$ORDER_ID/cancel \
  -H "Authorization: Bearer $OPERATOR_TOKEN" | jq '{status}'
curl -fsS -X POST http://127.0.0.1:8082/v1/orders/$ORDER_ID/cancel \
  -H "Authorization: Bearer $OPERATOR_TOKEN" | jq '{status}'

curl -fsS http://127.0.0.1:8082/web/v1/orders/$ORDER_ID/summary \
  -H "Authorization: Bearer $READER_TOKEN" \
  | jq '{partial, payment: (.payment.availability + ":" + (.payment.data.status // "-")), dispatch: (.dispatch.availability + ":" + (.dispatch.data.status // "-"))}'
```

Esperado: `CANCELLED` dos veces; resumen con pago `available:REFUNDED` y despacho
`available:CANCELLED`.

## 2. Compensación al fallar Despacho

El runner aislado ejecuta tres modos y cuatro escenarios, incluido el fallo de Despacho, y deja la
evidencia resumida. Usa las imágenes ya construidas para ese proyecto:

```bash
DEMO_INDEPENDENT_JSON="$(mktemp)"
P4_TEST_PROJECT=repuestossur-p4-final \
P4_TEST_PORT=8082 \
node tests/t2/p4-independent.mjs --no-build > "$DEMO_INDEPENDENT_JSON"

jq '{status, modes: [.modes[] | {name, smoke, stockBefore, stockAfter, deltas}], dispatchFailure: (.dispatchFailure | {status, code, replayStatus, replayCode, publicOrders, stockBefore, stockAfterFirst, stockAfter, deltas, replayDeltas}), restore}' \
  "$DEMO_INDEPENDENT_JSON"
```

Qué señalar:

- `stock` y `stock,dispatch` dejan el stock `5 → 5`; el resumen parcial no inventa un pago.
- Full: creación `201`, replay estable, resumen `partial:false` y cancelación con reembolso.
- `dispatchFailure`: `503 DISPATCH_UNAVAILABLE`, replay con el mismo código/mensaje, cero órdenes
  públicas y stock `5 → 5 → 5`. Los deltas `1/1/0` del primer fallo y `0/0/0` del replay muestran que
  la compensación no duplica efectos.
- `restore`: full y `DISPATCH_FAIL_CREATE=false` restaurados.

## 3. Continuidad E3

```bash
DEMO_CONTINUITY_JSON="$(mktemp)"
P4_TEST_PROJECT=repuestossur-p4-final \
P4_TEST_PORT=8082 \
node tests/t2/p4-continuity.mjs > "$DEMO_CONTINUITY_JSON"

jq '{status, params, arms: [.arms[] | {name, protected, post: .aggregate.post, get: .aggregate.get, repetitions: (.repetitions | length)}], restore}' \
  "$DEMO_CONTINUITY_JSON"

jq '.arms[] | {name, protected, circuit: [.repetitions[].resilience.circuit], bulkhead: [.repetitions[].resilience.bulkhead]}' \
  "$DEMO_CONTINUITY_JSON"
```

Qué señalar:

- Bulkhead activo: `6×201/12×503` en total, pico `2` y 4 rechazos por repetición. Apagado: `18×201`
  y 0 rechazos.
- Circuit Breaker activo: `24×503`; el simulador recibe `3/8` por repetición y el circuito abre una
  vez. Apagado: `24×503`, pero el simulador recibe `8/8` y no hay aperturas.
- `GET /v1/customers` responde `200` durante ambos brazos; 0 respuestas `429`.
- Los percentiles y `n` están en el JSON y en [VERIFICATION.md](VERIFICATION.md), §10. Son mecanismo,
  no SLO ni capacidad.
- `restore.ok: true`: simulador `normal`, flags por defecto, stock `200 → 200` y `5 → 5`, 36
  cancelaciones verificadas y cero pendientes.

## Cierre

- P4 queda cerrado en modo overlay local; la integración en el Compose raíz y la CI del grupo siguen
  pendientes de coordinación.
- No se grabó vídeo nuevo ni se alteró el preexistente.
- No se borraron volúmenes, no se reinició el simulador y no se detuvieron otros proyectos.
