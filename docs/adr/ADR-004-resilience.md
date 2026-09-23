# ADR-004 - Bounded waiting, explicit failure mapping and no hidden retries

**Status:** Accepted

## Context
Order creation and cancellation synchronously depend on Inventory. If Inventory is down or slow, Sales must not wait indefinitely and must expose a predictable public failure. This behavior is mandatory in the assignment and is also the selected experiment target.

## Alternatives considered
1. **Wait without a deadline.** Maximizes chance of eventual completion but can tie up Sales resources indefinitely.
2. **Deadline + automatic retries.** Can mask short transient failures, but mutating operations become harder to reason about and retries distort the timeout experiment.
3. **Deadline, idempotent Inventory mutations, no automatic transport retry.** Bounds latency while keeping retry decisions explicit at the caller/client level.
4. **Circuit breaker and Redis availability cache.** Potentially useful at larger scale, but unnecessary for the required scope and adds state/operational complexity.

## Decision
- Sales applies `INVENTORY_RPC_DEADLINE_MS=800` to every Inventory RPC.
- No automatic gRPC retry policy is configured in v1.
- `ReserveStock` and `ReleaseStock` are idempotent by `order_id`.
- gRPC `UNAVAILABLE` becomes HTTP **503** with `INVENTORY_UNAVAILABLE`.
- gRPC `DEADLINE_EXCEEDED` becomes HTTP **504** with `INVENTORY_TIMEOUT`.
- Sales never confirms an order when stock reservation is unknown/failed.
- Sales never marks an order cancelled until Inventory confirms stock release.

## Create-order compensation
1. Sales creates an idempotency record and stable `order_id`.
2. Sales calls `ReserveStock(order_id, items)`.
3. If reservation fails, no confirmed order is written.
4. If reservation succeeds but local order persistence fails, Sales calls `ReleaseStock(order_id)` as compensation and records/logs any compensation failure as a critical consistency incident.

## Cancellation
`ReleaseStock(order_id)` is called before transitioning the local order to `CANCELLED`. Repeating cancellation returns the already-cancelled order and does not restore stock twice.

## Cost accepted
- A slow Inventory call beyond 800 ms is failed even if it could have eventually succeeded.
- Without automatic retries, transient failures are more visible to callers.
- There remains a rare compensation-failure window because the system intentionally avoids a distributed transaction coordinator.

## Consequences
- The ABET experiment varies injected Inventory latency around the 800 ms boundary.
- Toxiproxy is used only for test/experiment infrastructure.
- A future cache, if added, may accelerate read-only inventory queries but must never authorize a sale from stale cached stock.
