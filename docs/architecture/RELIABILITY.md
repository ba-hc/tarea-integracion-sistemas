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
- duplicado concurrente mientras la primera solicitud sigue ejecutándose -> la implementación puede serializar/esperar brevemente o devolver HTTP 409 con un error estable de operación en curso, pero nunca debe crear dos órdenes.

### Mutaciones de Inventory
`ReserveStock` y `ReleaseStock` son idempotentes por `order_id` y persisten suficiente información en el registro de movimientos para evitar descontar o reponer stock dos veces.

## Prohibición de autorizar con caché obsoleta

Si Redis se implementa más adelante como bonificación opcional, puede cachear respuestas de solo lectura de `GetPart` o listados. Un valor cacheado de disponibilidad nunca debe utilizarse como autoridad para confirmar una orden. `ReserveStock` siempre se ejecuta contra la base de datos transaccional de Inventory.
