# Mapeo de errores y estados

## Envelope público de error REST

```json
{
  "code": "INVENTORY_UNAVAILABLE",
  "message": "Inventory service is unavailable",
  "traceId": "73a9be64-6e7e-42c2-badc-55f42f649668",
  "details": {}
}
```

`details` es opcional. Nunca se devuelven a los clientes stack traces internos, mensajes SQL ni errores gRPC en bruto.

## Códigos REST

| Situación | HTTP | Código público |
|---|---:|---|
| solicitud mal formada o inválida | 400 | `VALIDATION_ERROR` |
| API key ausente o inválida | 401 | `UNAUTHORIZED` |
| key válida sin el rol requerido | 403 | `FORBIDDEN` |
| cliente inexistente | 404 | `CUSTOMER_NOT_FOUND` |
| orden inexistente | 404 | `ORDER_NOT_FOUND` |
| email de cliente duplicado | 409 | `CUSTOMER_EMAIL_CONFLICT` |
| stock actual insuficiente | 409 | `INSUFFICIENT_STOCK` |
| key de idempotencia reutilizada con un payload diferente | 409 | `IDEMPOTENCY_KEY_CONFLICT` |
| pieza referenciada inexistente en Inventory | 422 | `PART_NOT_FOUND` |
| conexión o servicio Inventory no disponible | 503 | `INVENTORY_UNAVAILABLE` |
| deadline de Inventory excedido | 504 | `INVENTORY_TIMEOUT` |
| falla inesperada de Sales | 500 | `INTERNAL_ERROR` |

## Estados gRPC de Inventory

| Condición en Inventory | Estado gRPC |
|---|---|
| UUID mal formado en `GetPart`, `ReserveStock` o `ReleaseStock`; items vacíos, cantidad inválida o pieza duplicada en `ReserveStock` | `INVALID_ARGUMENT` |
| pieza solicitada inexistente en `GetPart` o `ReserveStock` | `NOT_FOUND` |
| `ReleaseStock` con un `order_id` que nunca tuvo una reserva | `NOT_FOUND` |
| stock insuficiente en una reserva | `FAILED_PRECONDITION` |
| `ReserveStock` con un `order_id` cuya reserva ya fue liberada (mismo payload) | `FAILED_PRECONDITION`; no cambia el stock |
| mismo `order_id` reutilizado con un payload de reserva distinto | `ALREADY_EXISTS` |
| error inesperado de base de datos o servidor | `INTERNAL` |
| servidor o red no disponible | `UNAVAILABLE` |
| deadline del llamador excedido | `DEADLINE_EXCEEDED` |

`ReserveStock` conserva la reserva ya liberada como estado terminal: no vuelve a descontar stock. El `order_id` lo genera Sales; la creación pública normal no reutiliza un id de orden cancelada.

## Traducción de Sales por operación

| Operación de Inventory | Estado gRPC | HTTP | Código público |
|---|---|---:|---|
| `GetPart`, `ReserveStock` | `INVALID_ARGUMENT` | 400 | `VALIDATION_ERROR` |
| `GetPart`, `ReserveStock` ante una pieza inexistente | `NOT_FOUND` | 422 | `PART_NOT_FOUND` |
| `ReserveStock` por falta de stock o reserva ya liberada | `FAILED_PRECONDITION` | 409 | `INSUFFICIENT_STOCK` |
| `ReserveStock` | `ALREADY_EXISTS` por payload distinto para el `order_id` | 500 | `INTERNAL_ERROR` |
| `ReleaseStock` ante una reserva inexistente o ya liberada | `NOT_FOUND` / `FAILED_PRECONDITION` | 500 | `INTERNAL_ERROR` |
| `ReleaseStock` ante cualquier otro rechazo inesperado del `order_id` interno | `INVALID_ARGUMENT` | 500 | `INTERNAL_ERROR` |
| cualquier RPC | `UNAVAILABLE` | 503 | `INVENTORY_UNAVAILABLE` |
| cualquier RPC | `DEADLINE_EXCEEDED` | 504 | `INVENTORY_TIMEOUT` |
| cualquier RPC | `INTERNAL` / `UNKNOWN` | 500 | `INTERNAL_ERROR` |

Sales traduce los errores de `ReleaseStock` a `INTERNAL_ERROR`: el identificador y la reserva provienen de una orden ya persistida por Sales, por lo que su ausencia o estado incompatible indica una inconsistencia entre servicios, no un error del cliente.

Sales traduce por operación y estado gRPC, no por el mensaje interno. La reserva ya liberada sólo es un guard de estado interno: el `order_id` no lo elige el cliente y la creación pública normal no reutiliza el id de una orden cancelada.
