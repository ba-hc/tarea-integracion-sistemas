# Data ownership and persistence baseline

## Sales database

### customers
- `id` UUID primary key
- `name` varchar(120)
- `email` normalized unique value
- `created_at`
- `updated_at`

### orders
- `id` UUID primary key
- `customer_id` local foreign key
- `status` (`CONFIRMED`, `CANCELLED`)
- `created_at`
- `updated_at`
- `cancelled_at` nullable

### order_items
- `id` UUID primary key
- `order_id` local foreign key
- `part_id` UUID value copied from Inventory (not a DB foreign key)
- `part_sku_snapshot`
- `part_name_snapshot`
- `quantity`

### idempotency_requests
- `key` unique
- `request_hash`
- `order_id`
- `state`
- serialized/fetchable response metadata sufficient for replay
- timestamps

## Inventory database

### parts
- `id` UUID primary key
- `sku` unique
- `name`
- `stock_available` integer check >= 0
- timestamps

### stock_operations
- unique logical `order_id`
- request fingerprint/hash for reservation
- reserve/release state
- timestamps

### stock_operation_items
- operation/order reference
- `part_id` local foreign key
- quantity
- stock-before/after evidence as needed

## Invariants

1. Only Inventory changes current stock.
2. Stock never becomes negative.
3. One order reservation is atomic across all lines.
4. A successful release cannot be applied twice.
5. Sales stores historical part snapshots deliberately; these are not used as current Inventory truth.
6. Cross-service database foreign keys do not exist.
