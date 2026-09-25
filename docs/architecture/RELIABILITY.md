# Contrato de resiliencia

## Deadline

`INVENTORY_RPC_DEADLINE_MS=800` es el valor predeterminado congelado para v1.

Sales lo aplica a `GetPart`, `ListParts`, `ReserveStock` y `ReleaseStock`. El valor se controla mediante configuración para que el experimento pueda ejecutar valores alternativos sin modificar código.

## Retries

No existen retries automáticos de gRPC en v1. Esto es deliberado:
- el comportamiento de las mutaciones sigue siendo fácil de explicar;
- los experimentos de fallas no quedan ocultos por retries transparentes;
- los retries explícitos de aplicación o cliente pueden apoyarse en la idempotencia.

## Idempotencia

### Creación pública de órdenes
Se requiere `Idempotency-Key`.

Para una misma key:
- mismo payload normalizado + solicitud completada -> reproducir la respuesta original;
- payload diferente -> HTTP 409 `IDEMPOTENCY_KEY_CONFLICT`;
- duplicado concurrente -> `SELECT ... FOR UPDATE` serializa el uso de la key; la segunda solicitud reproduce la orden confirmada sin invocar `ReserveStock` otra vez.

### Recuperación de respuestas ambiguas
Si `ReserveStock` termina con un error de transporte o un 5xx, Sales no persiste la orden ni marca la key como fallida: Inventory pudo haber confirmado la reserva antes de perderse la respuesta. El consumidor puede reintentar con la misma key y payload; Sales reutiliza el `order_id` estable e Inventory devuelve la reserva idempotente, sin descontarla otra vez. No hay retry automático.

Si la reserva tuvo éxito pero falla la persistencia local, Sales persiste el estado `COMPENSATING` antes de llamar a `ReleaseStock`. Los reintentos con la misma key finalizan la compensación bajo el lock de idempotencia; una respuesta de release perdida se puede reintentar porque `ReleaseStock` es idempotente. Si la transacción de orden sí se confirmó pero se perdió el ACK de commit, Sales vuelve a leer el estado confirmado y reproduce la respuesta original; no libera una reserva válida.

### Mutaciones de Inventory
`ReserveStock` y `ReleaseStock` son idempotentes por `order_id` y persisten suficiente información en el registro de movimientos para evitar descontar o reponer stock dos veces.

### Cancelación con persistencia local fallida
Si `ReleaseStock` tiene éxito y la actualización local de la orden falla, la orden permanece `CONFIRMED` aunque el stock ya esté liberado. El cliente debe reintentar la cancelación; el release idempotente no repone stock por segunda vez y el reintento puede completar el estado local. No hay retry automático.

## Prohibición de autorizar con caché obsoleta

Si Redis se implementa más adelante como bonificación opcional, puede cachear respuestas de solo lectura de `GetPart` o listados. Un valor cacheado de disponibilidad nunca debe utilizarse como autoridad para confirmar una orden. `ReserveStock` siempre se ejecuta contra la base de datos transaccional de Inventory.
