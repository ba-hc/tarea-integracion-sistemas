# P2: Pagos y resiliencia (T2-201, T2-202, T2-203)

**Estado:** Pagos está operativo e integrado en el Compose raíz junto con su pasarela simulada. Probado contra la Saga real de Ventas. Las fallas de la pasarela (lenta, caída, rechazo) se pueden provocar en caliente.

Contrato: [T2-INTERNAL-CONTRACTS.md](../architecture/T2-INTERNAL-CONTRACTS.md#contrato-de-pagos-t2-201). Decisiones de resiliencia: [ADR-006](../adr/ADR-006-resiliencia-pagos.md). Experimento de carga: [experiments/payments](../../experiments/payments/README.md).

## 1. Componentes

```mermaid
flowchart LR
    V[Ventas<br/>Saga, timeout 2 s] -->|REST interno| P[payments-api :3003]
    P --> DB[(payments-db)]
    P -->|timeout 1,2 s<br/>Circuit Breaker + Bulkhead| G[payment-gateway-sim :3010<br/>pasarela externa simulada]
    BFF[web-bff] -->|GET| P
```

- **`apps/payments-api`** (NestJS 12 + Prisma 7). Un cobro por venta en la tabla `payments` de su propia base. Ningún otro servicio la lee.
- **`apps/payment-gateway-sim`**. Representa al tercero externo: Node sin dependencias, con estado en memoria e idempotente por clave. Se reinicia vacío, como una pasarela de pruebas.
- **`GatewayGuard`** (`src/resilience`). Es la única puerta hacia la pasarela: Circuit Breaker, después Bulkhead y después la llamada con timeout.
- **`PaymentsReconciler`**. Cada 5 s consulta en la pasarela, sólo en lectura, los cobros y reembolsos que quedaron en duda.

## 2. Cobro y reembolso

```mermaid
stateDiagram-v2
    [*] --> PENDING: PUT (registro nuevo, gateway_attempts = 0)
    PENDING --> [*]: rechazo antes de la pasarela → 503 PAYMENT_CHARGE_REJECTED (se borra)
    PENDING --> CHARGED: pasarela APPROVED → 201
    PENDING --> DECLINED: pasarela DECLINED → 422
    PENDING --> PENDING: timeout / 5xx → 202 (reintento o reconciliador)
    CHARGED --> REFUND_PENDING: POST refund
    PENDING --> REFUND_PENDING: POST refund (cobro en duda)
    REFUND_PENDING --> REFUNDED: pasarela REFUNDED o VOIDED → 200
    REFUND_PENDING --> DECLINED: el cobro había sido rechazado → 409
    REFUND_PENDING --> REFUND_PENDING: sin confirmación → 202
```

Cada transición es un `UPDATE ... WHERE status = <esperado>`, así que dos solicitudes simultáneas no se pisan. La pasarela recibe siempre la misma clave por venta: `charge-{orderId}` para el cobro y `refund-{orderId}` para el reembolso. Repetir una llamada nunca produce un segundo efecto.

**Resultado incierto (T2-203).** Un cobro sin confirmación queda `PENDING`, y `GET` lo muestra así. Hay tres caminos para resolverlo, todos seguros:

1. Ventas repite el mismo `PUT`. Pagos reenvía el cobro con la misma clave y la pasarela devuelve el resultado original.
2. Ventas reembolsa. Si el cobro existía, se devuelve. Si nunca llegó, la pasarela anula la clave.
3. El reconciliador consulta `GET /v1/charges/charge-{orderId}` en la pasarela y fija `CHARGED`, `DECLINED` o `REFUNDED`. Si la pasarela no conoce el cobro, no hace nada: consultar nunca crea un cobro.

Para inspeccionar los registros en duda:

```bash
docker compose exec -T payments-db psql -U payments -d payments -c \
  "select order_id, status, gateway_attempts, last_error_code, updated_at
     from payments where status in ('PENDING','REFUND_PENDING') order by updated_at"
```

## 3. Protecciones (T2-202)

| Protección | Valor por defecto | Efecto |
|---|---|---|
| Timeout | `PAYMENTS_GATEWAY_TIMEOUT_MS=1200` | Ninguna llamada a la pasarela pasa de 1,2 s. Ventas espera 2 s, así que siempre recibe respuesta. |
| Circuit Breaker | Ventana 10, mínimo 5 llamadas, 50 % de fallas, abierto 5 s, 1 sonda | Con el circuito abierto, el cobro se rechaza en unos 6 ms sin tocar la pasarela. |
| Bulkhead | `PAYMENTS_BULKHEAD_MAX_CONCURRENT=8`, sin cola | Como máximo 8 llamadas en vuelo. El exceso se rechaza al instante. |
| Fallback | `503 PAYMENT_CHARGE_REJECTED` | Sólo cuando se garantiza que no hubo cobro. Si no, `202 PENDING`. Las lecturas se sirven desde la base local. |

`GET /internal/v1/resilience` expone el estado del circuito, los rechazos de cada protección, el pico en vuelo del bulkhead y el reconciliador. Los cambios de estado del circuito quedan en el log de Pagos (`GatewayGuard`). Todas las variables:

| Variable | Defecto | Uso |
|---|---|---|
| `PAYMENT_GATEWAY_URL` | `http://payment-gateway-sim:3010` | URL de la pasarela. |
| `PAYMENTS_GATEWAY_TIMEOUT_MS` | `1200` | Plazo por llamada (conexión, cabeceras y cuerpo). |
| `PAYMENTS_CIRCUIT_BREAKER_ENABLED` | `true` | `false` para el brazo sin protecciones. |
| `PAYMENTS_CB_WINDOW_SIZE` / `PAYMENTS_CB_MINIMUM_CALLS` | `10` / `5` | Ventana y mínimo de llamadas. |
| `PAYMENTS_CB_FAILURE_RATE_THRESHOLD` | `50` | Porcentaje de fallas que abre el circuito. |
| `PAYMENTS_CB_OPEN_MS` / `PAYMENTS_CB_HALF_OPEN_MAX_CALLS` | `5000` / `1` | Tiempo abierto y sondas en semiabierto. |
| `PAYMENTS_BULKHEAD_ENABLED` / `PAYMENTS_BULKHEAD_MAX_CONCURRENT` | `true` / `8` | Bulkhead. |
| `PAYMENTS_RECONCILE_INTERVAL_MS` | `5000` | Intervalo del reconciliador; `0` lo desactiva. |

## 4. Fallas reproducibles

La pasarela cambia de modo en caliente, sin reiniciar nada:

```bash
gateway_mode() {
  docker compose exec -T payment-gateway-sim node -e \
    "fetch('http://127.0.0.1:3010/admin/config',{method:'PUT',headers:{'content-type':'application/json'},body:process.argv[1]}).then(r=>r.text()).then(console.log)" "$1"
}
gateway_mode '{"mode":"slow","slowDelayMs":3000}'  # lenta: aplica el cobro y responde a los 3 s
gateway_mode '{"mode":"down"}'                     # caída: 503 GATEWAY_UNAVAILABLE sin aplicar nada
gateway_mode '{"mode":"decline"}'                  # rechaza los cobros nuevos
gateway_mode '{"mode":"normal"}'                   # vuelve a la normalidad
```

También se puede arrancar en un modo (`GATEWAY_SIM_MODE=slow docker compose up -d payment-gateway-sim`) o detener el contenedor (`docker compose stop payment-gateway-sim`) para provocar un error de conexión. `GET /admin/config` devuelve el modo y los contadores de efectos: cobros aprobados, rechazados, reembolsos y anulaciones.

## 5. Para P3: activar Pagos en la Saga

Pagos ya está en el Compose raíz, pero el defecto de Ventas sigue siendo `SAGA_STEPS=stock`. Para la Saga completa:

```bash
SAGA_STEPS=stock,payment,dispatch docker compose up --build -d --wait
```

Cambiar ese defecto en `docker-compose.yml` es una decisión del equipo (P3/P4). Con Pagos levantado, el BFF ya no ve Pagos como `unavailable`: para una venta sin cobro recibe `404` y lo reporta como `not_found`. `tests/t2/p4-smoke.mjs` todavía asume que Pagos no existe: espera `payment: 'unavailable'` en varios escenarios y rechaza un `SAGA_STEPS` que incluya `payment`. P4 debe actualizarlo junto con el cambio de `SAGA_STEPS`, como ya anticipaba [P3-SAGA.md §5](P3-SAGA.md#5-configuración-ventas).

## 6. Pruebas

```bash
cd apps/payment-gateway-sim && npm test              # 11 pruebas, sin dependencias
cd ../payments-api
npm ci && npm run prisma:generate
npm run typecheck && npm test                         # unitarias
docker compose --profile test up -d --wait payments-test-db   # desde la raíz
export TEST_DATABASE_URL='postgresql://payments:payments-test-only@localhost:5434/payments_test?schema=public'
npm run test:integration                              # PostgreSQL real + pasarela simulada real
npm run build
```

| Suite | Qué demuestra |
|---|---|
| `payment-gateway-sim/test` | Idempotencia por clave (también con 10 solicitudes simultáneas), conflicto de clave, modos `slow`/`down`/`decline`, aplicación del cobro aunque el cliente abandone, anulación de una clave nunca cobrada. |
| `test/resilience` | Transiciones del Circuit Breaker (umbral, ventana, semiabierto, reapertura, resultados de otra generación) y rechazo del Bulkhead. |
| `test/gateway` | Clasificación de respuestas de la pasarela: aprobado, rechazado, caída, conexión rechazada, timeout como resultado incierto. |
| `test/integration` | 201/200 sin doble cobro, 5 cobros simultáneos con un solo efecto, 409, 422 repetible, 503 sin registro con la pasarela caída, 202 en el plazo y reintento con un solo cobro, circuito que abre, responde rápido sin llamar y cierra tras una sonda, lecturas con el circuito abierto, 202 y no 503 para un cobro ya enviado, bulkhead lleno, protecciones apagadas, reembolso idempotente, `REFUND_PENDING` y su reintento, reembolso de un cobro en duda aplicado y anulación de uno no aplicado, reconciliador. |

## 7. Verificación realizada (2026-11-23, Linux arm64, Docker 29.10.0, Compose v5.8.0, Node 24.22.3 en contenedor)

- Pasarela simulada: **11/11** pruebas. Pagos: `npm run typecheck` OK, **30/30** unitarias, **26/26** de integración contra PostgreSQL 18.6. `prisma migrate diff` entre la base migrada y `schema.prisma`: sin diferencias. `npm run build` OK.
- `docker compose config --quiet` OK, también con los perfiles `test` y `payments-experiment`. `docker compose up --build -d --wait`: los 9 contenedores sanos.
- **Saga real con Pagos** (`SAGA_STEPS=stock,payment,dispatch`, Ventas, Inventario y Despacho reales):
  - Venta exitosa: `201` en 0,47 s, eventos `stock → payment → dispatch EXECUTE DONE`, cobro `CHARGED` por 20 000 CLP y stock −2. El replay con la misma key devolvió `201` sin un segundo cobro.
  - Cancelación: `payment COMPENSATE → stock COMPENSATE`, cobro `REFUNDED` y stock repuesto.
  - Despacho falla (`DISPATCH_FAIL_CREATE=true`): `503 DISPATCH_UNAVAILABLE` y eventos `dispatch REJECTED → payment COMPENSATE → stock COMPENSATE`. El cobro quedó `REFUNDED` y el stock intacto.
  - Pasarela en `decline`: `422 PAYMENT_DECLINED` y stock liberado.
  - Pasarela `down`: 6 ventas recibieron `503 PAYMENT_UNAVAILABLE` en 61–109 ms. El circuito quedó `OPEN` después de 5 fallas y la sexta se rechazó sin llamar a la pasarela. El stock no cambió y `GET /v1/customers` respondió `200` en 15 ms.
  - Pasarela `slow` (3 s): Ventas recibió `504 PAYMENT_TIMEOUT` en 1,36 s (Pagos respondió `202 PENDING` a los 1,2 s). Con la pasarela de vuelta, el reintento con la misma key dio `201`: `payment IN_DOUBT → payment DONE` y la pasarela registra un solo cobro `APPROVED`.
- **Experimento de carga:** 18 corridas. Resultados y análisis en [experiments/payments/README.md](../../experiments/payments/README.md).

No se ejecutó la CI de GitHub ni el smoke de P4 con Pagos activo (ver §5).

## 8. Límites conocidos

- La pasarela simulada guarda su estado en memoria: al reiniciarla, olvida los cobros. Pagos conserva los suyos, pero el reconciliador dejaría como `PENDING` los que no encuentre.
- El circuito y el bulkhead son por instancia (hay una sola).
- Reembolso total únicamente; no hay reembolsos parciales.
- Un cobro `PENDING` que la pasarela nunca recibió sólo se resuelve con un reintento o un reembolso de Ventas; el reconciliador no lo anula por su cuenta.
