# Contract changelog

## v1.1.0 - Saga de venta (T2-301, cambio compatible)

- `POST /v1/orders` ejecuta la Saga reservar stock -> cobrar -> crear despacho.
  La forma de las respuestas, los estados públicos (`CONFIRMED`, `CANCELLED`) y
  los códigos existentes no cambian.
- Códigos públicos nuevos dentro del schema `Error` existente:
  - 422 `PAYMENT_DECLINED`;
  - 503 `PAYMENT_UNAVAILABLE`, 504 `PAYMENT_TIMEOUT`;
  - 503 `DISPATCH_UNAVAILABLE`, 504 `DISPATCH_TIMEOUT`.
- `POST /v1/orders/{orderId}/cancel` compensa la venta en orden inverso y puede
  devolver los mismos 503/504 de Pagos y Despacho.
- Las respuestas reutilizables `InventoryUnavailable`/`InventoryTimeout` pasan a
  `DependencyUnavailable`/`DependencyTimeout`, con ejemplos para los tres
  servicios. Mismo status, cabeceras y schema.
- `inventory.proto` no cambia.

## v1.0.0 - frozen baseline

- Public REST API is `/v1`.
- Internal gRPC package is `repuestossur.inventory.v1`.
- Public order states are `CONFIRMED` and `CANCELLED`.
- `Idempotency-Key` is mandatory for `POST /v1/orders`.
- Inventory mutations are atomic for all items and idempotent by `order_id`.
- API authentication uses `X-API-Key` with `reader` and `operator` roles.
- Inventory `UNAVAILABLE` maps to HTTP 503.
- Inventory `DEADLINE_EXCEEDED` maps to HTTP 504.

Any breaking change requires a new major contract (`/v2` and/or `inventory.v2`).
