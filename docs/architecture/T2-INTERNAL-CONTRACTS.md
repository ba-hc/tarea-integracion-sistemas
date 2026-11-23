# Contratos internos de la T2

Inventario conserva su [contrato gRPC v1](../../contracts/grpc/repuestossur/inventory/v1/inventory.proto). Despacho y Pagos ofrecen interfaces REST internas. La [API pública de Ventas](../../contracts/rest/openapi.yaml) sigue siendo la de la T1.

## Identidad de la venta

Ventas genera y guarda un UUID antes de reservar stock, como ya hace con `idempotency_requests.order_id` en la T1. El orquestador de la T2 debe conservar ese UUID al reanudar la venta. Usa `orderId` en JSON y rutas REST, y el mismo valor como `order_id` en gRPC. El encabezado público `Idempotency-Key` vincula la solicitud del cliente con ese UUID. `traceId` sirve para seguir las llamadas en los logs.

Cada servicio guarda sus datos y aplica sus cambios en su propio almacén. Las operaciones se identifican por venta y acción. Repetir un comando con los mismos datos, incluso al mismo tiempo, no duplica el efecto. Reutilizar el identificador con datos distintos produce un conflicto. El orquestador registra qué pasos se confirmaron y compensa en orden inverso. Si Despacho rechaza la creación antes de guardar, el orquestador confirma el reembolso antes de liberar el stock.

## Inventario existente

| Operación | Solicitud | Resultado y reintento |
|---|---|---|
| `ReserveStock` | `order_id` e `items` con `part_id` y `quantity` | Reserva todos los ítems en una transacción. Con la misma reserva vigente devuelve el resultado anterior con `replayed=true`. Con otros ítems devuelve `ALREADY_EXISTS`. Una reserva liberada no se reactiva. |
| `ReleaseStock` | `order_id` | Repone las cantidades registradas para la venta. Si ya se liberó, devuelve el resultado anterior sin sumar stock. Si nunca hubo reserva, devuelve `NOT_FOUND`. |

Una pieza inexistente devuelve `NOT_FOUND` al reservar. El stock insuficiente o una reserva ya liberada devuelve `FAILED_PRECONDITION`. El cliente gRPC de Ventas usa un plazo de 800 ms por defecto. Véanse el [mapeo de errores](ERROR-MAPPING.md) y la [recuperación de respuestas ambiguas](RELIABILITY.md).

### Verificación de Inventario en T2-102

Pasaron 41 pruebas de integración con Node.js 24, un servidor gRPC real y una base PostgreSQL 18.6 aislada. Con 10 unidades y 20 reservas simultáneas de una unidad, 10 solicitudes se aceptaron, 10 se rechazaron por stock insuficiente y el stock final fue cero. Una reserva de varios ítems se aplica completa o deja el stock intacto. Repetir la reserva o la liberación para la misma orden, incluso en paralelo, modifica el stock una sola vez por operación.

Para repetir la verificación, configura `TEST_DATABASE_URL` con una base desechable cuyo nombre contenga `test`. La suite aplica migraciones y vacía tablas. Desde la raíz del repo:

```bash
cd apps/inventory-grpc
npm ci
npm run prisma:generate
npm run test:integration -- test/integration/grpc-stock.spec.ts \
  test/integration/grpc-stock-concurrency.spec.ts test/integration/persistence.spec.ts
```

## Despacho

El servicio escucha en `http://dispatch-api:3001` dentro de la red de Compose y usa su propia base PostgreSQL. Hay un despacho por venta. Para prepararlo basta con `items`, una lista no vacía de `partId` únicos y cantidades enteras positivas en `quantity`. Cambiar el orden de los ítems no cambia la solicitud. La respuesta contiene `orderId`, `items` y `status` (`CREATED` o `CANCELLED`).

| Operación | Ruta | Resultado |
|---|---|---|
| Crear | `PUT /internal/v1/dispatches/{orderId}` | `201` al crear, `200` al repetir los mismos ítems de un despacho vigente, `409 DISPATCH_CONFLICT` si cambian los ítems y `409 DISPATCH_CANCELLED` si se intenta reactivar un despacho. |
| Consultar | `GET /internal/v1/dispatches/{orderId}` | `200` con el estado actual o `404` si no existe. |
| Cancelar | `POST /internal/v1/dispatches/{orderId}/cancel` | `200` con estado `CANCELLED`, incluso si ya estaba cancelado. `404` si no existe. |

Una solicitud inválida devuelve `400 VALIDATION_ERROR`. Con `DISPATCH_FAIL_CREATE=true`, una venta nueva recibe `503 DISPATCH_CREATE_REJECTED` antes de que el servicio escriba el despacho. Ese código confirma el rechazo de esa llamada. Un `503` genérico no ofrece esa garantía. El modo está desactivado por defecto.

### Verificación de Despacho en T2-103

Desde la raíz del repo, levanta el entorno local y ejecuta las pruebas HTTP dentro de la red de Compose.

```bash
docker compose up --build -d --wait
docker compose exec -T dispatch-api node --input-type=module - < apps/dispatch-api/test/dispatch.integration.mjs
```

Para probar el rechazo antes de persistir y devolver el servicio a su modo normal:

```bash
DISPATCH_FAIL_CREATE=true docker compose up -d --wait dispatch-api
docker compose exec -T dispatch-api node --input-type=module - < apps/dispatch-api/test/dispatch.integration.mjs
DISPATCH_FAIL_CREATE=false docker compose up -d --wait dispatch-api
```

## Contrato de Pagos (T2-201)

Pagos (`apps/payments-api`) escucha en `http://payments-api:3003` dentro de la red de Compose y guarda sus cobros en su propia base PostgreSQL (`payments-db`). No publica puertos en el host. Hay un único cobro por venta, identificado por el mismo `orderId` de Ventas. El cuerpo del cobro es `{ "amountMinor": <entero positivo>, "currency": "CLP" }`, con la moneda en código ISO 4217 en mayúsculas. Las respuestas exitosas o pendientes tienen la forma `{ orderId, amountMinor, currency, status }` y los errores usan el envelope `{ code, message, traceId }`. Pagos acepta `X-Trace-Id` (UUID), lo devuelve en la respuesta y lo propaga a la pasarela.

| Operación | Ruta | Resultado |
|---|---|---|
| Cobrar | `PUT /internal/v1/payments/{orderId}` | `201 CHARGED` al confirmar el cobro y `200 CHARGED` al repetirlo, sin volver a cobrar. `202 PENDING` si la pasarela no confirmó dentro del plazo. `422 PAYMENT_DECLINED` si la pasarela lo rechazó, también al repetirlo. `409 PAYMENT_CONFLICT` si cambian el importe o la moneda y `409 PAYMENT_ALREADY_REFUNDED` si la venta ya se reembolsó. `503 PAYMENT_CHARGE_REJECTED` si Pagos rechazó **sin** que la pasarela llegara a cobrar. |
| Consultar | `GET /internal/v1/payments/{orderId}` | `200` con el estado guardado o `404 PAYMENT_NOT_FOUND`. Nunca llama a la pasarela, así que responde aunque esté caída. |
| Reembolsar | `POST /internal/v1/payments/{orderId}/refund` | `200 REFUNDED`, también al repetirlo. `202 REFUND_PENDING` si no se confirmó. `404 PAYMENT_NOT_FOUND` si no hay registro. `409 PAYMENT_NOT_REFUNDABLE` si el cobro fue rechazado (`GET` devuelve `DECLINED`). `503 PAYMENT_REFUND_REJECTED` si el circuito o el bulkhead impidieron intentarlo; el estado no cambia. |
| Protecciones | `GET /internal/v1/resilience` | Estado del Circuit Breaker y del Bulkhead y contadores de rechazos, para el experimento y la demo. |

Estados: `PENDING` (cobro enviado o por enviar, resultado incierto), `CHARGED`, `DECLINED`, `REFUND_PENDING` y `REFUNDED`. `REFUNDED` significa que la venta no retiene dinero: el cobro se devolvió o, si nunca llegó a la pasarela, su clave quedó anulada.

Lo que garantiza cada respuesta:

- **`503 PAYMENT_CHARGE_REJECTED`** garantiza que no hubo cobro. Pagos sólo la envía en dos casos: si la pasarela nunca recibió ese cobro (`gateway_attempts = 0`), o si la pasarela confirmó que no lo aplicó en el único intento. En ambos borra el registro con una condición sobre ese estado. Con el circuito abierto, un cobro que ya se había enviado antes recibe `202 PENDING`, no esta garantía.
- **`202 PENDING`** indica un resultado incierto. Repetir el mismo `PUT` es seguro: la pasarela es idempotente por la clave `charge-{orderId}`, así que el reintento resuelve el cobro sin duplicarlo.
- **Reembolsar un cobro incierto** también es seguro. El reembolso usa su propia clave (`refund-{orderId}`). Si el cobro existía, lo devuelve. Si nunca llegó, la pasarela anula la clave y un cobro tardío con esa clave no tiene efecto.
- **Consulta de un resultado incierto:** `GET` devuelve `PENDING` mientras no se resuelva. El reconciliador de Pagos (`PAYMENTS_RECONCILE_INTERVAL_MS`, 5 s por defecto) consulta la pasarela por la clave del cobro, sólo en lectura, y pasa el registro a `CHARGED`, `DECLINED` o `REFUNDED`. Si la pasarela no conoce el cobro, el registro sigue `PENDING` hasta que Ventas repita el cobro o lo reembolse.

Plazos: Pagos espera a la pasarela 1,2 s (`PAYMENTS_GATEWAY_TIMEOUT_MS`), menos que los 2 s con que Ventas espera a Pagos (`PAYMENTS_TIMEOUT_MS`). Así Pagos alcanza a responder `202` o un rechazo antes de que Ventas abandone la llamada. El importe lo fija Ventas: unidades × `SALE_UNIT_PRICE_MINOR` (10 000 por defecto), en `CLP`, guardado en la Saga al crearla.

El diseño, las protecciones y la verificación están en [P2-PAGOS.md](../t2/P2-PAGOS.md) y [ADR-006](../adr/ADR-006-resiliencia-pagos.md).

## Decisiones ante una falla

- Un rechazo de negocio confirmado permite actuar sobre los pasos anteriores ya confirmados. En las interfaces REST nuevas, el cuerpo de error incluye `code`, `message` y `traceId`.
- Un timeout, una respuesta perdida o un error técnico sin confirmación deja el resultado incierto. Guarda el paso pendiente y consulta por `orderId` o repite el mismo comando idempotente con el mismo identificador y datos. Una consulta con `404` mientras la llamada original podría seguir en curso no basta para descartar el efecto. En Inventario v1 no hay consulta de reserva por orden. Repetir `ReserveStock` para continuar puede efectuar la reserva si la primera llamada no la aplicó.
- Si el cobro o el despacho siguen inciertos, espera a reconciliar el resultado antes de avanzar o compensar. Un reembolso sin confirmación queda pendiente. Todas las llamadas entre servicios deben tener un plazo de espera.
