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

## Justificación
Las alternativas 1 y 3 se compararon midiendo, no argumentando. El experimento RS-402 inyectó
seis latencias con Toxiproxy en el salto Sales → Inventory y ejecutó dos brazos de
`INVENTORY_RPC_DEADLINE_MS` —800 ms y 60000 ms, este último como línea base sin deadline
efectivo— con tres repeticiones de 30 s a 5 req/s cada uno. Medias de las tres repeticiones, en
milisegundos:

| Latencia inyectada | p95 con deadline | p95 sin deadline | 504 con deadline |
|---:|---:|---:|---:|
| 0 | 28 | 27 | 0 |
| 250 | 287 | 283 | 0 |
| 500 | 519 | 513 | 0 |
| 750 | 779 | 765 | 0 |
| 1000 | 825 | 1013 | 452 de 452 |
| 1500 | 823 | 1514 | 453 de 453 |

Tres lecturas sostienen la decisión:

1. **Mientras Inventory responde dentro del presupuesto, el deadline no cuesta nada.** Hasta los
   750 ms inyectados los dos brazos son indistinguibles y no aparece un solo 504.
2. **Cuando Inventory se degrada, el deadline acota la espera.** A 1000 y 1500 ms inyectados la
   latencia observada se estanca en unos 825 ms de p95 y no superó los 836 ms de máximo en
   ninguna corrida, mientras que sin deadline sigue a la latencia inyectada sin techo.
3. **El costo es total, no gradual.** En esas dos condiciones el 100 % de las solicitudes se
   convirtió en 504 y no se confirmó ninguna orden. El deadline no degrada suavemente: cambia
   disponibilidad por una falla acotada y explícita, que es justamente el intercambio que esta
   decisión acepta.

La alternativa 1 queda descartada por evidencia y no por preferencia: no produjo ningún 504, pero
hizo esperar al llamador 1,5 s con Inventory a 1500 ms, y esa espera crece con la lentitud de la
dependencia sin límite superior.

Límite de la medición: el barrido llega a 1500 ms de latencia inyectada y a 5 req/s, por debajo
de las 10 conexiones del pool de PostgreSQL de Sales. No se midió el punto en que la espera sin
deadline agota ese pool y la degradación deja de ser sólo latencia; ese efecto sería peor que el
observado, así que la evidencia acota el beneficio por abajo, no por arriba. Datos fila por fila
en [`experiments/timeout/results/summary.csv`](../../experiments/timeout/results/summary.csv).

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
