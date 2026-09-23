# Contract changelog

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
