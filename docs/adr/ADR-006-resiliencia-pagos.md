# ADR-006 - Timeout, Circuit Breaker y Bulkhead entre Pagos y la pasarela

**Estado:** Aceptada (T2-201, T2-202, T2-203).

## Contexto

Pagos depende de una pasarela externa que el equipo no controla y que, según el encargo, se vuelve lenta o se cae en los picos. Si Pagos espera sin límite, cada venta en curso retiene un socket, memoria y una conexión de Ventas, y la falla de la pasarela se propaga a toda la venta.

Restricciones previas:

- AGENTS.md §9 no permite circuit breakers ni retries automáticos salvo que una decisión arquitectónica lo justifique. ADR-004 (T1) dejó a Ventas → Inventory sólo con deadline, sin retries ni circuito.
- Ventas espera a Pagos 2 s (`PAYMENTS_TIMEOUT_MS`) y trata `503 PAYMENT_CHARGE_REJECTED` como garantía de «no hubo cobro» ([P3-SAGA.md §6](../t2/P3-SAGA.md#6-contrato-que-ventas-espera-de-pagos-para-p2)).
- Cada cobro debe poder reintentarse sin cobrar dos veces.

El encargo pide explícitamente timeout, Circuit Breaker con fallback y Bulkhead en la llamada a la pasarela. Este ADR es la decisión que AGENTS.md §9 exige para incorporarlos.

## Decisión 1: las protecciones viven sólo en el borde Pagos → pasarela

La dependencia frágil es la pasarela, así que el Circuit Breaker y el Bulkhead se ponen en la única llamada que sale hacia ella (`GatewayGuard`, en `apps/payments-api/src/resilience`). Ventas → Pagos conserva sólo su timeout de 2 s y la Saga de ADR-005. Proteger también ese salto duplicaría estados de circuito que se contradicen y ocultaría el origen de la falla.

## Decisión 2: timeout de 1,2 s, menor que el de Ventas

`PAYMENTS_GATEWAY_TIMEOUT_MS = 1200` cubre conexión, cabeceras y cuerpo. Es menor que los 2 s de Ventas para que Pagos siempre alcance a responder algo útil (`202 PENDING` o `503 PAYMENT_CHARGE_REJECTED`) antes de que Ventas abandone la llamada. La pasarela en condiciones normales responde en decenas de milisegundos, así que el margen no corta cobros sanos.

## Decisión 3: Circuit Breaker por conteo, implementado en el servicio

- **Ventana:** las últimas 10 llamadas. Con al menos 5 en la ventana y una tasa de fallas de 50 % o más, el circuito se abre.
- **Abierto:** 5 s rechazando sin llamar a la pasarela.
- **Semiabierto:** deja pasar una sonda. Si sale bien, cierra; si falla, vuelve a abrir.
- **Qué es una falla:** timeout, 5xx, conexión rechazada y respuestas ilegibles. Un cobro rechazado (`DECLINED`) es un éxito técnico: la pasarela funciona. Las respuestas 4xx inesperadas no cuentan para ningún lado.

Se implementó en unas 120 líneas en lugar de agregar una librería. La semántica queda explícita y probada: el resultado de una llamada iniciada antes de un cambio de estado no altera el estado nuevo (contador de generación), y una sonda «ignorada» libera su cupo. Además no se suma una dependencia con su propio ciclo de versiones.

## Decisión 4: Bulkhead de 8 llamadas simultáneas, sin cola

Como máximo 8 llamadas a la pasarela en vuelo (`PAYMENTS_BULKHEAD_MAX_CONCURRENT`). Si están todas ocupadas, el cobro se rechaza al instante. Con la pasarela sana (unos 30 ms por llamada), 8 cupos admiten del orden de 250 cobros por segundo según la ley de Little, muy por encima de la carga del experimento. Con la pasarela lenta, acota a 8 los sockets y la memoria retenidos.

No hay cola porque esperar en ella sólo consumiría el plazo de 2 s de Ventas y convertiría un rechazo rápido y seguro en un timeout incierto.

## Decisión 5: el fallback sólo promete lo que puede garantizar

Cuando el circuito o el bulkhead impiden la llamada, Pagos responde `503 PAYMENT_CHARGE_REJECTED` **sólo** si la pasarela nunca recibió ese cobro (`gateway_attempts = 0`). Para un cobro ya enviado antes, la respuesta es `202 PENDING`, porque Pagos no puede saber si se aplicó. La misma garantía se da cuando la pasarela confirma que no aplicó el cobro (`503 GATEWAY_UNAVAILABLE` o conexión rechazada) en el único intento.

Las lecturas (`GET`) no pasan por la pasarela y se responden desde la base de Pagos, así que siguen funcionando con el circuito abierto.

## Decisión 6: sin retries automáticos dentro de Pagos

Pagos hace una sola llamada por solicitud, como manda ADR-004. Quien reintenta es la Saga de Ventas, con el mismo `orderId`. La pasarela es idempotente por `charge-{orderId}` y `refund-{orderId}`, así que un reintento nunca duplica el efecto. El reconciliador de Pagos sólo consulta la pasarela (lectura) para resolver registros `PENDING` y `REFUND_PENDING`. Pasa por el mismo `GatewayGuard`: con el circuito abierto, no consulta.

## Consecuencias

- **Estado por instancia:** el circuito y el bulkhead viven en memoria. Con varias réplicas de Pagos, cada una abriría su propio circuito. En este alcance hay una sola instancia.
- **Fail-fast con efecto en la venta:** con el circuito abierto, Ventas recibe `503 PAYMENT_CHARGE_REJECTED`, libera el stock y responde `503 PAYMENT_UNAVAILABLE` en milisegundos, en lugar de retener stock y conexiones durante el plazo.
- **Primeras fallas:** las primeras ventas tras la caída pagan el timeout completo y quedan `PENDING` hasta que alguien reintente, reembolse o el reconciliador las resuelva. El circuito necesita al menos 5 fallas para abrir.
- **Rechazos por saturación:** si el bulkhead es demasiado chico para la carga real, se rechazan cobros sanos. El valor es configurable y el experimento registra los rechazos por separado.
- **Experimento:** cada protección se puede apagar por variable de entorno (`PAYMENTS_CIRCUIT_BREAKER_ENABLED`, `PAYMENTS_BULKHEAD_ENABLED`, `PAYMENTS_GATEWAY_TIMEOUT_MS`) para comparar con y sin protecciones ([experiments/payments](../../experiments/payments/README.md)).
