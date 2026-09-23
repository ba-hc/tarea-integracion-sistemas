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
2. Sales llama a `ReserveStock(order_id, items)`.
3. Si la reserva falla, no se escribe ninguna orden confirmada.
4. Si la reserva tiene éxito pero falla la persistencia local de la orden, Sales llama a `ReleaseStock(order_id)` como compensación y registra cualquier falla de compensación como un incidente crítico de consistencia.

## Cancelación
`ReleaseStock(order_id)` se invoca antes de cambiar la orden local a `CANCELLED`. Repetir una cancelación devuelve la orden ya cancelada y no repone el stock una segunda vez.

## Costo aceptado
- Una llamada lenta a Inventory que supere los 800 ms falla aunque eventualmente pudiera haber respondido.
- Sin retries automáticos, las fallas transitorias son más visibles para los consumidores.
- Permanece una ventana poco frecuente de falla de compensación porque el sistema evita deliberadamente un coordinador de transacciones distribuidas.

## Consecuencias
- El experimento ABET varía la latencia inyectada de Inventory alrededor del límite de 800 ms.
- Toxiproxy se utiliza únicamente como infraestructura de pruebas y experimentación.
- Una futura caché, si se añade, puede acelerar consultas de inventario de solo lectura, pero nunca debe autorizar una venta usando stock cacheado potencialmente obsoleto.
