# Contratos internos de la T2

T2-101. Inventario conserva su [contrato gRPC v1](../../contracts/grpc/repuestossur/inventory/v1/inventory.proto). Las interfaces REST de Despacho y Pagos son propuestas internas. La [API pública de Ventas](../../contracts/rest/openapi.yaml) sigue siendo la de la T1.

## Identidad de la venta

Ventas genera y guarda un UUID antes de reservar stock, como ya hace con `idempotency_requests.order_id` en la T1. El orquestador de la T2 debe conservar ese UUID al reanudar la venta. Usa `orderId` en JSON y rutas REST, y el mismo valor como `order_id` en gRPC. El encabezado público `Idempotency-Key` vincula la solicitud del cliente con ese UUID. `traceId` sirve para seguir las llamadas en los logs.

Cada servicio guarda sus datos y aplica sus cambios en su propio almacén. Las operaciones se identifican por venta y acción. Repetir un comando con los mismos datos, incluso al mismo tiempo, no duplica el efecto. Reutilizar el identificador con datos distintos produce un conflicto. El orquestador registra qué pasos se confirmaron y compensa en orden inverso. Si Despacho rechaza la creación antes de guardar, el orquestador confirma el reembolso antes de liberar el stock.

## Inventario existente

| Operación | Solicitud | Resultado y reintento |
|---|---|---|
| `ReserveStock` | `order_id` e `items` con `part_id` y `quantity` | Reserva todos los ítems en una transacción. Con la misma reserva vigente devuelve el resultado anterior con `replayed=true`. Con otros ítems devuelve `ALREADY_EXISTS`. Una reserva liberada no se reactiva. |
| `ReleaseStock` | `order_id` | Repone las cantidades registradas para la venta. Si ya se liberó, devuelve el resultado anterior sin sumar stock. Si nunca hubo reserva, devuelve `NOT_FOUND`. |

Una pieza inexistente devuelve `NOT_FOUND` al reservar. El stock insuficiente o una reserva ya liberada devuelve `FAILED_PRECONDITION`. El cliente gRPC de Ventas usa un plazo de 800 ms por defecto. Véanse el [mapeo de errores](ERROR-MAPPING.md) y la [recuperación de respuestas ambiguas](RELIABILITY.md).

## Despacho propuesto

REST interno en la red de Compose. Se propone un despacho por venta. Para prepararlo basta con `items`, una lista no vacía de `partId` únicos y cantidades enteras positivas en `quantity`. Cambiar el orden de los ítems no cambia la solicitud. La respuesta contiene `orderId`, `items` y `status` (`CREATED` o `CANCELLED`).

| Operación | Ruta | Resultado |
|---|---|---|
| Crear | `PUT /internal/v1/dispatches/{orderId}` | `201` al crear, `200` al repetir los mismos ítems de un despacho vigente y `409` si cambian los ítems o el despacho ya está cancelado. |
| Consultar | `GET /internal/v1/dispatches/{orderId}` | `200` con el estado actual o `404` si no existe. |
| Cancelar | `POST /internal/v1/dispatches/{orderId}/cancel` | `200` con estado `CANCELLED`, incluso si ya estaba cancelado. `404` si no existe. |

Una solicitud inválida devuelve `400`. En T2-103, el modo de falla estará desactivado por defecto. Para una venta nueva, devolverá `503 DISPATCH_CREATE_REJECTED` antes de guardar el despacho. Ese código confirma el rechazo de esa llamada. Un `503` genérico no ofrece esa garantía.

## Propuesta de contrato para Pagos

Se propone REST interno con el mismo `orderId` como identificador de un único cobro por venta. El cuerpo de creación contiene `amountMinor` (entero positivo en la unidad menor de la moneda) y `currency`. La respuesta incluye esos campos, `orderId` y `status`.

| Operación | Ruta propuesta | Resultado esperado |
|---|---|---|
| Cobrar | `PUT /internal/v1/payments/{orderId}` | `201` para un cobro nuevo confirmado y `200` al repetir un cobro aplicado, con el estado actual y sin volver a cobrar. `409` si cambian el importe o la moneda y `422 PAYMENT_DECLINED` si la pasarela rechaza el cobro de forma definitiva. |
| Consultar | `GET /internal/v1/payments/{orderId}` | `200` con el estado actual o `404` si aún no hay registro para la venta. |
| Reembolsar | `POST /internal/v1/payments/{orderId}/refund` | `200` con estado `REFUNDED` cuando se confirma, también al repetirlo. `404` si no hay registro y `409` si el estado no permite reembolsar. |

P2 debe acordar con P3 las rutas y códigos definitivos, la moneda y el origen del importe. Los contratos actuales no incluyen precios. También queda por acordar cómo guardar y consultar el resultado incierto de la pasarela. Como base, `CHARGED`, `DECLINED` y `REFUNDED` representan resultados confirmados, y `202` con `PENDING` o `REFUND_PENDING` indica que la operación sigue por confirmar. El cobro y el reembolso necesitan claves estables distintas entre sí y reutilizables en sus respectivos reintentos contra la pasarela.

## Decisiones ante una falla

- Un rechazo de negocio confirmado permite actuar sobre los pasos anteriores ya confirmados. En las interfaces REST nuevas, el cuerpo de error incluye `code`, `message` y `traceId`.
- Un timeout, una respuesta perdida o un error técnico sin confirmación deja el resultado incierto. Guarda el paso pendiente y consulta por `orderId` o repite el mismo comando idempotente con el mismo identificador y datos. Una consulta con `404` mientras la llamada original podría seguir en curso no basta para descartar el efecto. En Inventario v1 no hay consulta de reserva por orden. Repetir `ReserveStock` para continuar puede efectuar la reserva si la primera llamada no la aplicó.
- Si el cobro o el despacho siguen inciertos, espera a reconciliar el resultado antes de avanzar o compensar. Un reembolso sin confirmación queda pendiente. Todas las llamadas entre servicios deben tener un plazo de espera.
