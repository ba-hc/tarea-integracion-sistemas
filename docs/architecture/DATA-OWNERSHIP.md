# Línea base de propiedad de datos y persistencia

## Base de datos de Sales

### customers
- `id` UUID como clave primaria
- `name` varchar(120)
- `email` como valor único normalizado
- `created_at`
- `updated_at`

### orders
- `id` UUID como clave primaria
- `customer_id` como clave foránea local
- `status` (`CONFIRMED`, `CANCELLED`)
- `created_at`
- `updated_at`
- `cancelled_at` nullable

### order_items
- `id` UUID como clave primaria
- `order_id` como clave foránea local
- `part_id` como valor UUID copiado desde Inventory (no es una clave foránea de base de datos)
- `part_sku_snapshot`
- `part_name_snapshot`
- `quantity`

### idempotency_requests
- `key` única
- `request_hash`
- `order_id`
- `state` (`IN_PROGRESS`, `COMPENSATING`, `CONFIRMED`, `FAILED`)
- metadatos serializados o recuperables de la respuesta suficientes para reproducirla
- timestamps

## Base de datos de Inventory

### parts
- `id` UUID como clave primaria
- `sku` único
- `name`
- `stock_available` entero con restricción >= 0
- timestamps

### stock_operations
- `order_id` lógico único
- fingerprint/hash de la solicitud de reserva
- estado de reserva/liberación
- timestamps

### stock_operation_items
- referencia a operación/orden
- `part_id` como clave foránea local
- cantidad
- evidencia de stock antes/después según sea necesario

## Invariantes

1. Sólo Inventory modifica el stock actual.
2. El stock nunca puede ser negativo.
3. La reserva de una orden es atómica para todas sus líneas.
4. Una liberación exitosa no puede aplicarse dos veces.
5. Sales almacena deliberadamente snapshots históricos de las piezas; éstos no se utilizan como fuente de verdad del estado actual de Inventory.
6. No existen claves foráneas entre bases de datos de servicios distintos.
