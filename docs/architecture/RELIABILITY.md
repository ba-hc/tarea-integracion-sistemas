# Reliability contract

## Deadline

`INVENTORY_RPC_DEADLINE_MS=800` is the frozen v1 default.

Sales applies it to `GetPart`, `ListParts`, `ReserveStock` and `ReleaseStock`. The value is configuration-driven so the experiment can run alternate values without changing code.

## Retries

No automatic gRPC retries in v1. This is deliberate:
- mutation behavior remains easy to explain,
- fault experiments are not hidden by transparent retries,
- explicit application/client retries can rely on idempotency.

## Idempotency

### Public create-order
`Idempotency-Key` is required.

For the same key:
- same normalized request payload + completed request -> replay the original response;
- different payload -> HTTP 409 `IDEMPOTENCY_KEY_CONFLICT`;
- concurrent duplicate while first request is still executing -> implementation may serialize/wait briefly or return HTTP 409 with a stable in-progress error, but it must never create two orders.

### Inventory mutation
`ReserveStock` and `ReleaseStock` are idempotent by `order_id` and persist enough ledger data to avoid double decrement/replenishment.

## No stale cache authorization

If Redis is implemented later as an optional bonus, it may cache read-only `GetPart`/list responses. A cached availability value must never be used as the authority to confirm an order. `ReserveStock` always executes against Inventory's transactional database.
