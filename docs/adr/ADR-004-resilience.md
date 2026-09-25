# ADR-004 - Espera acotada, mapeo explícito de fallas y ausencia de retries ocultos

**Estado:** Aceptada

## Contexto
La creación y la cancelación de órdenes dependen sincrónicamente de Inventory. Si Inventory está caído o responde lentamente, Sales no debe esperar indefinidamente y debe exponer una falla pública predecible. Este comportamiento es obligatorio en el encargo y también es el objetivo del experimento seleccionado.

## Alternativas consideradas
1. **Esperar sin deadline.** Maximiza la posibilidad de completar eventualmente la operación, pero puede mantener ocupados los recursos de Sales indefinidamente.
2. **Deadline + retries automáticos.** Puede ocultar fallas transitorias breves, pero las operaciones que mutan estado se vuelven más difíciles de razonar y los retries distorsionan el experimento de timeout.
3. **Deadline, mutaciones idempotentes en Inventory y sin retry automático de transporte.** Acota la latencia y mantiene explícitas las decisiones de reintento a nivel de cliente o llamador.
4. **Circuit breaker y caché de disponibilidad con Redis.** Podrían ser útiles a mayor escala, pero no son necesarios para el alcance requerido y añaden estado y complejidad operacional.

## Decisión
- Sales aplica `INVENTORY_RPC_DEADLINE_MS=800` a cada RPC de Inventory.
- No se configura una política de retry automático de gRPC en v1.
- `ReserveStock` y `ReleaseStock` son idempotentes por `order_id`.
- gRPC `UNAVAILABLE` se traduce a HTTP **503** con `INVENTORY_UNAVAILABLE`.
- gRPC `DEADLINE_EXCEEDED` se traduce a HTTP **504** con `INVENTORY_TIMEOUT`.
- Sales nunca confirma una orden cuando la reserva de stock es desconocida o ha fallado.
- Sales nunca marca una orden como cancelada hasta que Inventory confirme la liberación de stock.

## Compensación al crear una orden
1. Sales crea un registro de idempotencia y un `order_id` UUID estable.
2. Sales llama a `ReserveStock(order_id, items)`. Un timeout, error de transporte o 5xx conserva la key en estado recuperable porque la reserva pudo confirmarse antes de perder la respuesta.
3. Tras una reserva exitosa, Sales guarda la orden, sus snapshots y la respuesta original dentro de su transacción local.
4. Si falla la persistencia local, Sales persiste `COMPENSATING` antes de liberar stock; los retries con la misma key completan el release idempotente bajo el lock de la key y conservan un resultado estable.
5. Si se pierde el ACK de commit local, Sales vuelve a leer la key. Si la orden está confirmada, reproduce la respuesta original y no libera stock.

## Cancelación
`ReleaseStock(order_id)` se invoca antes de cambiar la orden local a `CANCELLED`. Si la liberación tiene éxito pero falla la actualización local, un retry de cancelación repite el release idempotente y completa el estado local sin reponer stock dos veces.

## Costo aceptado
- Una llamada lenta a Inventory que supere los 800 ms falla aunque eventualmente pudiera haber respondido.
- No existen retries automáticos; el consumidor debe reintentar una respuesta ambigua con la misma `Idempotency-Key` o repetir una cancelación fallida.
- No hay coordinador distribuido ni worker de recuperación: `COMPENSATING` permanece durable y se completa en el siguiente retry si el proceso o la base de datos fallan durante la compensación.

## Consecuencias
- El experimento ABET varía la latencia inyectada de Inventory alrededor del límite de 800 ms.
- Toxiproxy se utiliza únicamente como infraestructura de pruebas y experimentación.
- Una futura caché, si se añade, puede acelerar consultas de inventario de solo lectura, pero nunca debe autorizar una venta usando stock cacheado potencialmente obsoleto.
