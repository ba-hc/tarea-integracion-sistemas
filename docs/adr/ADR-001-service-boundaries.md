# ADR-001 - Separate Sales and Inventory bounded contexts

**Status:** Accepted

## Context
RepuestosSur has two pre-existing responsibilities that evolve for different reasons: Sales owns customers and sales orders, while Inventory owns parts and stock. The assignment also requires a database per service and forbids one service from directly accessing another service's database.

## Alternatives considered
1. **Single monolith and one database.** Simplest deployment and transactions, but it does not represent the required integration problem and violates the required service separation.
2. **Two services with a shared database.** Keeps process boundaries but couples both services through a hidden shared schema and violates database-per-service.
3. **Two services with independent databases and explicit contracts.** Adds network/distributed-system complexity but preserves ownership boundaries and makes integration observable and testable.

## Decision
Use two independently deployable services:
- **Sales:** customers, orders, idempotency records and immutable part snapshots used by orders.
- **Inventory:** parts, available stock and stock-movement ledger.

Sales communicates with Inventory only through the versioned gRPC contract. No cross-database reads or writes are allowed.

## Justification
The split follows the two sources of truth in the problem statement. Inventory remains authoritative for current stock. Sales remains authoritative for customers and order lifecycle. A small amount of intentional duplication is accepted: an order stores the part `sku` and `name` returned by Inventory at confirmation time, so historical orders remain readable even if the catalog changes later.

## Cost accepted
- Network failures become possible.
- A distributed transaction is unavailable; the create-order flow needs compensation if local persistence fails after stock reservation.
- Two databases and two services must be operated and tested.

## Consequences
- Each service has a dedicated PostgreSQL database and credentials.
- Sales cannot query Inventory tables.
- Integration failures are part of the API behavior and must be measured.
- If the business later needs pricing, ownership must be decided explicitly rather than adding shared tables.
