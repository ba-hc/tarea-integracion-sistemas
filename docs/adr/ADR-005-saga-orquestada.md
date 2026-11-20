# ADR-005 - Venta como Saga orquestada por Ventas

**Estado:** Aceptada (T2-301/T2-303). Pagos (P2) sigue pendiente de integración.

## Contexto

En la T2, «vender un repuesto» cruza tres servicios con almacenes propios: Inventory (reserva stock por gRPC), Pagos (cobra en una pasarela externa) y Despacho (crea la orden de entrega). El problema que plantea el encargo es justamente el estado inconsistente: a veces se cobra y no hay stock, o se cobra y nunca se despacha.

Restricciones que ya existían:

- Cada servicio es dueño de su base y nadie escribe en la base de otro (ADR-001, DATA-OWNERSHIP.md).
- Inventory sólo expone `ReserveStock`/`ReleaseStock`, idempotentes por `order_id` (contrato gRPC congelado).
- Despacho ofrece crear/cancelar idempotentes por `orderId`, y Pagos se propuso con cobrar/reembolsar idempotentes por `orderId` (T2-INTERNAL-CONTRACTS.md).
- La API pública sólo conoce órdenes `CONFIRMED` y `CANCELLED`, y una creación fallida no puede exponer una orden a medias.
- Pagos es la dependencia frágil del dominio: una pasarela externa, lenta o caída en picos.

## Decisión 1: Saga y no Two-Phase Commit

Se usa una Saga: cada paso es una transacción local confirmada en su servicio, y cada uno tiene una acción compensatoria (liberar stock, reembolsar, cancelar despacho).

2PC se descartó por estas razones:

1. **La pasarela de pagos no participa en un protocolo de preparación.** Es un tercero: cobra o rechaza. No ofrece un «prepare» que retenga fondos bajo nuestro coordinador. 2PC exige que todos los participantes voten y esperen el commit, y aquí uno de ellos no puede.
2. **2PC bloquea recursos mientras espera al más lento.** Con Pagos lento, Inventory y Despacho mantendrían locks abiertos durante segundos, y si el coordinador cae entre el *prepare* y el *commit*, quedan bloqueados hasta que vuelva. Es justo la falla en cascada que el encargo pide contener.
3. **Rompe la autonomía de las bases.** Exigiría transacciones XA/`PREPARE TRANSACTION` coordinadas entre tres PostgreSQL de dueños distintos, contra ADR-001 y contra la regla de no tener transacciones distribuidas (AGENTS.md §9).
4. **Las operaciones ya son compensables y el negocio acepta consistencia eventual.** Liberar una reserva, reembolsar un cobro y cancelar un despacho son acciones de negocio legítimas. Que durante unos segundos exista una reserva que después se libera no viola ninguna regla de negocio, porque el stock nunca baja de lo disponible.

El costo aceptado es que no hay aislamiento: entre la reserva y la compensación, ese stock no está disponible para otras ventas. Se mitiga con plazos cortos (timeouts, aborto a los `SAGA_ABORT_AFTER_MS`) y con la regla de no exponer la orden hasta el final.

## Decisión 2: orquestación y no coreografía

El orquestador vive en Ventas (`SaleSagaOrchestrator`), que ya era dueño de la orden y de la `Idempotency-Key`. Llama a los servicios con comandos síncronos y guarda el avance en su propia base (`sale_sagas`, `sale_saga_events`).

| Criterio | Orquestación (elegida) | Coreografía |
|---|---|---|
| Dónde vive el flujo | En un archivo: el orden de pasos y compensaciones se lee de arriba abajo. | Repartido entre los servicios, como reacciones a eventos. |
| Orden inverso estricto | Lo garantiza el orquestador: no reembolsa antes de cancelar el despacho ni libera stock antes de reembolsar. | Cada servicio debería saber qué eventos esperar antes de compensar; es fácil equivocarse. |
| Infraestructura | Llamadas HTTP/gRPC que ya existían, más una tabla en la base de Ventas. | Requiere un broker (Kafka/RabbitMQ) y un outbox en cada servicio, contra AGENTS.md §9. |
| Respuesta al cliente | `POST /v1/orders` responde con el resultado real (201 o el error público). | La respuesta sería asíncrona: habría que exponer `PENDING`, un estado público que el contrato no tiene. |
| Evidencia para la defensa | Un solo lugar (`sale_saga_events`) muestra pasos y compensaciones con su hora. | Habría que correlacionar logs de tres servicios. |
| Acoplamiento | Ventas conoce a los tres servicios (un acoplamiento aceptable: es el dueño de la venta). | Menor acoplamiento directo, pero un acoplamiento implícito por eventos. |

Con tres pasos lineales y un único dueño natural del proceso, la coreografía añade infraestructura sin dar beneficios que necesitemos. La orquestación es la solución más simple que se puede defender línea por línea.

## Reglas de diseño que acompañan la decisión

- **Write-ahead:** antes de enviar un comando, el paso se marca `IN_DOUBT`. Una caída del proceso nunca deja «no se hizo» cuando en realidad quizá se hizo.
- **Rechazo confirmado frente a duda.** Un rechazo confirmado (stock insuficiente, pago rechazado, `DISPATCH_CREATE_REJECTED`, `PAYMENT_CHARGE_REJECTED`, conexión rechazada) compensa de inmediato. Un timeout o un 5xx genérico deja el paso en duda: no se compensa en caliente, porque la llamada original podría seguir aplicándose.
- **Recuperación hacia adelante o hacia atrás.** Un reintento con la misma `Idempotency-Key` repite el mismo comando idempotente (hacia adelante). Si nadie reintenta, el recuperador aborta pasado `SAGA_ABORT_AFTER_MS` y compensa (hacia atrás).
- **Idempotencia en todos los saltos:** misma `Idempotency-Key` → mismo `orderId` → mismo comando en cada servicio. Así un reintento no cobra, reserva ni despacha dos veces.
- **Un solo ejecutor por Saga:** un lease con dueño (`lease_owner`, `lease_until`) y escrituras condicionadas a ese dueño.
- **Sin retries automáticos ocultos** (ADR-004). Los reintentos los decide el cliente (misma key) o el recuperador (compensaciones con backoff exponencial), y siempre quedan registrados.

## Consecuencias

- Hay una ventana de inconsistencia temporal y observable (estado interno `RUNNING` o `COMPENSATING`) que no se expone por REST.
- Si un cobro quedó en duda y Pagos sigue caído, el stock de esa venta queda retenido hasta que Pagos confirme el reembolso o que nunca hubo cobro. Se prefiere retener stock un rato a liberarlo para otra venta cuando el cliente quizá ya pagó.
- El contrato público suma códigos de error (contrato v1.1.0, cambio compatible).
- El detalle operativo está en [P3-SAGA.md](../t2/P3-SAGA.md).
