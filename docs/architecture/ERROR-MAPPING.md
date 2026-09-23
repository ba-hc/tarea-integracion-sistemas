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
| UUID mal formado, items vacíos, cantidad inválida o pieza duplicada en la solicitud | `INVALID_ARGUMENT` |
| pieza solicitada inexistente | `NOT_FOUND` |
| stock insuficiente | `FAILED_PRECONDITION` |
| mismo `order_id` reutilizado con un payload de reserva distinto | `ALREADY_EXISTS` |
| error inesperado de base de datos o servidor | `INTERNAL` |
| servidor o red no disponible | `UNAVAILABLE` |
| deadline del llamador excedido | `DEADLINE_EXCEEDED` |

## Traducción de Sales para llamadas que mutan órdenes

| gRPC | HTTP | Código público |
|---|---:|---|
| `INVALID_ARGUMENT` | 400 | `VALIDATION_ERROR` |
| `NOT_FOUND` | 422 | `PART_NOT_FOUND` |
| `FAILED_PRECONDITION` | 409 | `INSUFFICIENT_STOCK` |
| `ALREADY_EXISTS` por inconsistencia interna de `order_id` | 500 | `INTERNAL_ERROR` |
| `UNAVAILABLE` | 503 | `INVENTORY_UNAVAILABLE` |
| `DEADLINE_EXCEEDED` | 504 | `INVENTORY_TIMEOUT` |
| `INTERNAL` / `UNKNOWN` | 500 | `INTERNAL_ERROR` |
