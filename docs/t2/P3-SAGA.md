# P3: Saga de venta en Ventas (T2-301, T2-302, T2-303)

**Estado:** Saga, compensaciones y recuperación implementadas y probadas. Pagos (P2) está integrado y el Compose raíz ejecuta por defecto la Saga completa (`SAGA_STEPS=stock,payment,dispatch`). Los subconjuntos de §5 sirven sólo para pruebas aisladas. La evidencia end-to-end está en [docs/evidencia](../evidencia/README.md).

Decisiones de arquitectura: [ADR-005](../adr/ADR-005-saga-orquestada.md).

## 1. Flujo

La operación pública sigue siendo `POST /v1/orders` con `Idempotency-Key`, y la orden pública sólo existe al final.

```mermaid
sequenceDiagram
    autonumber
    participant C as Cliente (vía Gateway)
    participant V as Ventas (orquestador)
    participant DB as Ventas DB
    participant I as Inventario (gRPC)
    participant P as Pagos (REST)
    participant D as Despacho (REST)
    C->>V: POST /v1/orders + Idempotency-Key
    V->>DB: reclamar key, crear sale_sagas (RUNNING)
    V->>DB: stock = IN_DOUBT
    V->>I: ReserveStock(order_id)
    I-->>V: OK
    V->>DB: stock = DONE (+ snapshot)
    V->>DB: payment = IN_DOUBT
    V->>P: PUT /internal/v1/payments/{orderId}
    P-->>V: 201 CHARGED
    V->>DB: payment = DONE
    V->>DB: dispatch = IN_DOUBT
    V->>D: PUT /internal/v1/dispatches/{orderId}
    D-->>V: 201 CREATED
    V->>DB: 1 transacción: orders CONFIRMED + key CONFIRMED + saga COMPLETED
    V-->>C: 201 Order CONFIRMED
```

Si falla el último paso, se compensa en orden inverso (escenario 2 del encargo):

```mermaid
sequenceDiagram
    autonumber
    participant C as Cliente
    participant V as Ventas
    participant I as Inventario
    participant P as Pagos
    participant D as Despacho
    C->>V: POST /v1/orders
    V->>I: ReserveStock → OK
    V->>P: cobrar → CHARGED
    V->>D: crear despacho
    D-->>V: 503 DISPATCH_CREATE_REJECTED (rechazo confirmado)
    Note over V: saga COMPENSATING, key COMPENSATING con el error público
    V->>P: POST .../refund → REFUNDED
    V->>I: ReleaseStock → OK
    Note over V: saga FAILED, key FAILED, ninguna orden creada
    V-->>C: 503 DISPATCH_UNAVAILABLE
```

## 2. Estado persistido

`sale_sagas` (una fila por venta, en la base de Ventas) guarda el estado general, el estado de cada paso, el monto, la moneda, el snapshot de la reserva, el error público, el error del último intento, los reintentos, el backoff y el lease. `sale_saga_events` es una bitácora append-only de cada ejecución y compensación: es la evidencia del orden inverso.

```mermaid
stateDiagram-v2
    [*] --> RUNNING: key nueva
    RUNNING --> COMPLETED: los 3 pasos DONE + orden creada
    RUNNING --> RUNNING: paso en duda (503/504), reintento con la misma key
    RUNNING --> COMPENSATING: paso rechazado / recuperador aborta un paso en duda
    COMPENSATING --> COMPENSATING: compensación no confirmada (backoff)
    COMPENSATING --> FAILED: todos los pasos compensados
    COMPLETED --> CANCELLING: POST /v1/orders/{id}/cancel
    CANCELLING --> CANCELLING: compensación no confirmada (backoff)
    CANCELLING --> CANCELLED: despacho, pago y stock compensados
```

Estado de cada paso: `SKIPPED` (no configurado), `NOT_STARTED`, `IN_DOUBT` (comando enviado o por enviar, resultado desconocido), `DONE`, `REJECTED` (el servicio confirmó que no lo aplicó) y `COMPENSATED` (revertido o confirmado inexistente).

El estado público no cambia: la orden sólo aparece como `CONFIRMED` y luego puede pasar a `CANCELLED`. `RUNNING` y `COMPENSATING` son internos.

## 3. Cómo se clasifica cada respuesta

| Paso | Hecho (`done`) | Rechazo confirmado → compensar | En duda → no compensar en caliente |
|---|---|---|---|
| Reservar stock | gRPC OK | `INVALID_ARGUMENT`, `NOT_FOUND`, `FAILED_PRECONDITION` (400/422/409) | `UNAVAILABLE`, `DEADLINE_EXCEEDED`, `INTERNAL` |
| Cobrar | 200/201 `CHARGED` | 422, 200 `DECLINED`, 503 `PAYMENT_CHARGE_REJECTED`, 400, conexión rechazada | timeout, 202 `PENDING`, 409, otro 5xx |
| Crear despacho | 200/201 `CREATED` | 503 `DISPATCH_CREATE_REJECTED`, 400, conexión rechazada | timeout, 409, otro 5xx |

«Conexión rechazada» (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`) es un rechazo seguro: no se envió ningún byte. Un timeout no lo es, porque el servidor pudo haber aplicado el comando.

| Compensación | Confirmada | Pendiente (backoff) |
|---|---|---|
| Cancelar despacho | 200 `CANCELLED`; 404 si el paso estaba en duda | resto |
| Reembolsar | 200 `REFUNDED`; 404 si el cobro estaba en duda; 409 + `GET` = `DECLINED` | 202 `REFUND_PENDING`, timeout, 5xx |
| Liberar stock | gRPC OK; `NOT_FOUND` si la reserva estaba en duda | `UNAVAILABLE`, `DEADLINE_EXCEEDED`, etc. |

Un 404 sobre un paso que estaba **confirmado** (`DONE`) no se acepta. Indica una inconsistencia: se registra como error y se reintenta.

El orden inverso es **estricto**: la Saga se detiene en la primera compensación pendiente. Así nunca se libera stock de una venta cuyo cobro todavía no se devolvió.

## 4. Reintentos y recuperación (T2-302)

| Situación | Qué ve el cliente | Qué pasa después |
|---|---|---|
| Paso en duda | 503/504 del servicio (`PAYMENT_TIMEOUT`, etc.) | Un reintento con la misma key repite el **mismo** comando: sin doble cobro ni doble reserva. |
| Nadie reintenta | — | Pasado `SAGA_ABORT_AFTER_MS` (30 s por defecto), el recuperador aborta, compensa en orden inverso y fija como resultado el último error que vio el cliente. |
| Compensación no confirmada | El error público ya fijado | `sale_sagas.next_attempt_at` con backoff exponencial (`SAGA_RECOVERY_INTERVAL_MS` × 2ⁿ, tope `SAGA_MAX_BACKOFF_MS`). El recuperador la retoma, y un reintento con la misma key también. |
| Falla la persistencia local al final | 500 `INTERNAL_ERROR` | Los pasos remotos ya están `DONE`: se reintenta sólo la transacción local (hacia adelante), sin compensar. |
| Se pierde el ACK del commit final | 201 (replay) | Se relee la Saga `COMPLETED` y se reproduce la respuesta. |
| Cancelación con una compensación pendiente | 503/504 de esa dependencia; la orden sigue `CONFIRMED` | El recuperador termina la cancelación. |

El recuperador (`SagaRecoveryWorker`) es un temporizador dentro de Ventas que cada `SAGA_RECOVERY_INTERVAL_MS` revisa como máximo 20 Sagas. No usa broker ni colas.

Para que un solo proceso trabaje cada Saga se usa un lease (`lease_owner`, `lease_until`). Toda escritura exige `lease_owner = <yo>`. Un reintento concurrente con la misma key espera a que el lease se libere y luego reproduce el resultado.

`SAGA_LEASE_MS` debe superar dos veces la suma de los timeouts (pasos más compensaciones), y `SAGA_ABORT_AFTER_MS` no puede ser menor que el lease. Así, cuando se aborta un paso en duda, ninguna llamada original puede seguir en curso. La configuración se valida al arrancar.

## 5. Configuración (Ventas)

| Variable | Defecto | Uso |
|---|---|---|
| `SAGA_STEPS` | `stock,payment,dispatch` | Pasos activos, en orden y empezando por `stock`. El Compose raíz usa `stock` hasta integrar Pagos. |
| `PAYMENTS_BASE_URL` | `http://payments-api:3003` | URL interna de Pagos (P2). |
| `PAYMENTS_TIMEOUT_MS` | `2000` | Plazo por llamada a Pagos (conexión, cabeceras y cuerpo). |
| `DISPATCH_BASE_URL` | `http://dispatch-api:3001` | URL interna de Despacho. |
| `DISPATCH_TIMEOUT_MS` | `1500` | Plazo por llamada a Despacho. |
| `INVENTORY_RPC_DEADLINE_MS` | `800` | Sin cambios (T1). |
| `SALE_UNIT_PRICE_MINOR` | `10000` | Precio unitario en la unidad menor; monto = unidades × precio. |
| `SALE_CURRENCY` | `CLP` | Moneda ISO 4217 enviada a Pagos. |
| `SAGA_LEASE_MS` | máx(30000, 2·Σtimeouts + 5000) | Duración del lease. |
| `SAGA_ABORT_AFTER_MS` | `SAGA_LEASE_MS` | Espera de un paso en duda antes de abortar. |
| `SAGA_RECOVERY_ENABLED` | `true` | Activa el recuperador. |
| `SAGA_RECOVERY_INTERVAL_MS` | `2000` | Intervalo del recuperador y base del backoff. |
| `SAGA_MAX_BACKOFF_MS` | `60000` | Tope del backoff de compensaciones. |

El precio es una decisión del equipo: los contratos no tienen precios y el `.proto` de Inventory está congelado. El monto y la moneda se guardan en la Saga al crearla, así que un reintento siempre envía el mismo importe a Pagos.

Activar la Saga en el Compose raíz, desde la raíz del repositorio:

```bash
# Saga con Despacho (sin Pagos), por ejemplo para el escenario 2 sin cobro:
SAGA_STEPS=stock,dispatch docker compose up --build -d --wait
# Escenario 2 (falla del último paso): Despacho rechaza antes de guardar.
SAGA_STEPS=stock,dispatch DISPATCH_FAIL_CREATE=true docker compose up -d --wait dispatch-api sales-api
```

En PowerShell, primero define las variables (`$env:SAGA_STEPS="stock,dispatch"`) y luego ejecuta el mismo `docker compose`.

Por qué el defecto es `stock`: con `stock,dispatch`, cada venta real crea un despacho. El smoke de P4 (`tests/t2/p4-smoke.mjs`) verifica que el resumen de una orden real no tenga Pagos ni Despacho (espera 503/404), así que fallaría. Cuando Pagos esté integrado, el equipo debe cambiar a la vez el defecto del Compose a `stock,payment,dispatch` y esa aserción del smoke.

## 6. Contrato que Ventas espera de Pagos (para P2)

Se basa en la propuesta de [T2-INTERNAL-CONTRACTS.md](../architecture/T2-INTERNAL-CONTRACTS.md#contrato-de-pagos-t2-201), con dos precisiones:

- `PUT /internal/v1/payments/{orderId}` con `{ "amountMinor": <int>, "currency": "CLP" }`. Responde `201 CHARGED` la primera vez y `200` con el estado actual al repetirse, sin volver a cobrar. Ante un rechazo definitivo de la pasarela, `422 PAYMENT_DECLINED`.
- **Fallback del Circuit Breaker / Bulkhead:** cuando Pagos rechaza **antes** de contactar a la pasarela (circuito abierto o bulkhead lleno), debe responder `503` con `code: "PAYMENT_CHARGE_REJECTED"`. Ese código garantiza que no hubo cobro, igual que `DISPATCH_CREATE_REJECTED` en Despacho. Con él, Ventas libera el stock al instante (fail-fast). Un 503 sin ese código se trata como «en duda».
- `202 PENDING`: la pasarela no confirmó dentro del plazo de Pagos. Ventas lo trata como «en duda» y reintenta con el mismo comando.
- `POST /internal/v1/payments/{orderId}/refund`: `200 REFUNDED` (también al repetir), `404` si no hay registro, `409` si el estado no permite reembolsar (Ventas consulta `GET` y acepta `DECLINED`), `202 REFUND_PENDING` si sigue por confirmar.
- El timeout interno de Pagos hacia la pasarela debe ser **menor** que `PAYMENTS_TIMEOUT_MS` (2 s). Así Pagos responde algo antes de que Ventas abandone la llamada.
- Pagos debe propagar o aceptar `X-Trace-Id` (UUID) para correlacionar logs.

Para integrar Pagos basta con agregar `payments-api` al Compose y quitar el override `SAGA_STEPS` (o ponerlo en `stock,payment,dispatch`).

## 7. Contrato público (v1.1.0)

Cambio compatible y dedicado, en [openapi.yaml](../../contracts/rest/openapi.yaml) y [contracts/CHANGELOG.md](../../contracts/CHANGELOG.md). Se suman los códigos `PAYMENT_DECLINED` (422), `PAYMENT_UNAVAILABLE`/`DISPATCH_UNAVAILABLE` (503) y `PAYMENT_TIMEOUT`/`DISPATCH_TIMEOUT` (504). No cambian los estados, los schemas ni los códigos existentes. Detalle en [ERROR-MAPPING.md](../architecture/ERROR-MAPPING.md#saga-de-venta-t2).

Verificado: `@redocly/cli@2.54.2 lint` es válido, con los mismos 6 warnings que el contrato `contracts-v1.0.0`, y `oasdiff breaking` contra `contracts-v1.0.0` no reporta cambios incompatibles (exit 0).

## 8. Pruebas (T2-303)

```bash
cd apps/sales-api
npm ci && npm run prisma:generate
npm run typecheck
npm test                                   # unitarias, incluye los clientes HTTP contra stubs
docker compose --profile test up -d --wait sales-test-db   # desde la raíz
export TEST_DATABASE_URL='postgresql://sales:sales-test-only@localhost:5433/sales_test?schema=public'
npm run test:integration                   # PostgreSQL real
npm run build
```

| Suite | Qué demuestra |
|---|---|
| `test/saga/payments.client.spec.ts`, `dispatch.client.spec.ts` | La clasificación de la tabla §3 contra un servidor HTTP real: timeout, conexión rechazada, `PAYMENT_CHARGE_REJECTED`, `DISPATCH_CREATE_REJECTED`, 404 sólo si el paso estaba en duda, y una única llamada por intento (sin retry oculto). |
| `test/integration/saga.integration.spec.ts` | Camino feliz con monto 2 × 10 000 CLP. Cinco solicitudes concurrentes con la misma key → 1 reserva, 1 cobro, 1 despacho. Falla de Despacho → `refund` y luego `release`, sin orden ni cobro. Orden inverso estricto con reembolso pendiente y recuperación posterior. Pago rechazado o con circuito abierto → libera stock. Pago en duda → reintento con un solo cobro efectivo. Recuperador que aborta y compensa. Despacho en duda → `cancel`, `refund` y `release`. Cancelación en orden inverso, y cancelación pendiente que termina el recuperador. |
| `test/integration/orders.integration.spec.ts` | Regresión de la T1 sobre el flujo nuevo: replay tras cancelar, conflicto de key, cliente inexistente, rechazo de Inventory, respuestas ambiguas, ACK perdido, falla de persistencia final, cancelaciones con fallas y orden previa a la Saga. |

## 9. Verificación realizada (2026-11-19, Windows + Docker 29.8.0, Node 24.21.0)

- `npm run typecheck`: OK. `npm test`: **136 pruebas** pasaron. `npm run test:integration`: **25 pruebas** pasaron tres veces seguidas contra PostgreSQL 18.6. `prisma migrate diff` entre la migración y `schema.prisma`: sin diferencias.
- `SAGA_STEPS=stock,dispatch docker compose up --build -d --wait` (Compose raíz): los 6 contenedores sanos. Venta real por REST → 201, despacho `CREATED` en Despacho, Saga `COMPLETED`.
- Saga completa con Inventario y Despacho reales, y un **stub temporal de Pagos fuera del repositorio** (un contenedor con alias `payments-api` en la red de Compose, `SAGA_STEPS=stock,payment,dispatch`):
  - Escenario 1: 201, stock −2, eventos `stock/payment/dispatch EXECUTE DONE`. Un replay con la misma key devolvió 201 y Pagos recibió **un solo** `PUT`.
  - Escenario 2 (`DISPATCH_FAIL_CREATE=true`): 503 `DISPATCH_UNAVAILABLE`. Eventos `dispatch EXECUTE REJECTED → payment COMPENSATE → stock COMPENSATE`, con 27 ms entre reembolso y liberación. El stock volvió a 200, el cobro quedó `REFUNDED` y no se creó ninguna orden. Un reintento con la misma key devolvió el mismo 503.
  - Cancelación: `dispatch → payment → stock COMPENSATE`, despacho `CANCELLED` y stock repuesto.
  - Pagos detenido: 504 `PAYMENT_TIMEOUT` (en este Docker la resolución DNS de un contenedor detenido tarda más que el plazo de 2 s), con el stock retenido. Con Pagos de vuelta, el recuperador abortó a los ~31 s: `sale ABORT STALLED → payment COMPENSATE` (404 aceptado porque el cobro estaba en duda) `→ stock COMPENSATE`, y el stock se repuso.
- Pruebas de sistema de la T1 (`tests/system`, perfil `experiment` como en CI): 26/26 pasaron y 3 se omitieron por defecto. Con `RUN_FAILURE_TESTS=1`, 28/29: falla «con Inventory detenido responde 503», que recibe 504. **La misma prueba falla igual sobre el commit base `697439f`, sin estos cambios** (se verificó en un worktree aparte): con Inventory detenido, Toxiproxy tarda más de 800 ms en resolver el nombre en este Docker de Windows. No lo causa la Saga; queda por confirmar en la CI de Linux.

No se ejecutó: la CI de GitHub, ni la integración real con Pagos (P2) y su Circuit Breaker/Bulkhead.

## 10. Evidencia para el informe y la demo

Bitácora de una venta (desde la raíz):

```bash
docker compose exec -T sales-db psql -U sales -d sales -c \
  "select e.step, e.action, e.outcome, e.code, e.created_at
     from sale_saga_events e join sale_sagas s using (order_id)
    where s.idempotency_key = '<Idempotency-Key>' order by e.id"
```

Sagas pendientes de compensar:

```bash
docker compose exec -T sales-db psql -U sales -d sales -c \
  "select order_id, status, stock_status, payment_status, dispatch_status,
          compensation_attempts, next_attempt_at, last_error_code
     from sale_sagas where status in ('RUNNING','COMPENSATING','CANCELLING')"
```

Los logs de Ventas (`SaleSaga`, `SagaRecovery`, `PaymentsGateway`, `DispatchGateway`) registran el paso, el resultado, la duración, el `orderId` y el `traceId`. Nunca registran cuerpos ni secretos.

## 11. Límites conocidos

- Pagos no existe todavía: el paso 2 se probó con dobles y con un stub temporal, no con el servicio de P2.
- El recuperador corre en cada instancia de Ventas. El lease evita trabajo duplicado, pero no hay reparto de carga entre instancias (no hace falta en este alcance).
- Una venta con el cobro en duda retiene su stock mientras Pagos no responda (ver ADR-005, Consecuencias).
- Precio único para todos los repuestos (decisión del equipo).
