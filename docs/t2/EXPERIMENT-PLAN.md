# T2-402/403 — plan de experimento

**Estado:** smoke parcial ejecutado; E1–E3 no ejecutados. P3 existe en Sales y publica el control
`DISPATCH_FAIL_CREATE=true`. Pagos P2 no existe, así que no hay Circuit Breaker, Bulkhead ni toggles
P2. La evidencia del smoke parcial está en [VERIFICATION.md](VERIFICATION.md), §9; no es evidencia
de E1–E3.

## Lo ya ejecutado: smoke parcial

La corrida real del runner cubrió `stock`, `stock,dispatch` y `DISPATCH_FAIL_CREATE=true` sin Pagos.
Dejó `GetPart` `5 → 5` en los dos primeros modos y `5 → 5 → 5` antes/tras el primer 503/tras el
replay en el tercero. El fallo de Despacho devolvió `503 DISPATCH_UNAVAILABLE`, replay con el mismo
código/mensaje, cero órdenes públicas y `GET /v1/customers` `200`. No usó fixture sintética.

Ese smoke no mide latencia, tasas, Circuit Breaker, Bulkhead, reembolso ni la Saga de tres pasos. No
se presentan sus resultados como E1–E3.

## Hipótesis y controles

- **H1 — protección de fallas:** con Circuit Breaker y Bulkhead de P2, una dependencia lenta o
  caída debe acotar latencia y rechazos sin tumbar la continuidad de `GET /v1/customers`.
- **H2 — compensación:** si el último paso confirmado falla (Despacho), la Saga de P3 debe
  compensar en orden inverso los pasos anteriores. El control es el mismo flujo con éxito.
- **H3 — pico de Pagos:** una fuente Pagos lenta o caída debe activar las protecciones acordadas
  en P2 sin que el rate limit del Gateway oculte el Circuit Breaker o el Bulkhead.

P3 ya publica `DISPATCH_FAIL_CREATE=true`; no se inventan toggles de P2. E2 no compara un brazo “sin
compensación”: no se desactivan invariantes de la Saga. La comparación con y sin protecciones se
limita a E1/E3, en un entorno P2 aislado y coordinado.

## Escenarios

| ID | Escenario | Brazo A | Brazo B | Qué debe observarse |
|---|---|---|---|---|
| E1 | Éxito completo | Flujo normal | Flujo normal con protecciones P2 | Estado final confirmado y mismos efectos de negocio. |
| E2 | Falla en el último paso (Despacho) | Camino normal, sin falla | `DISPATCH_FAIL_CREATE=true` con compensación P3 activa | El stock y los pasos previos quedan en el estado acordado; no se duplican efectos. |
| E3 | Pagos lento o caído en pico | Sin protección | Circuit Breaker/Bulkhead P2 en entorno aislado y coordinado | Latencia acotada, rechazos explícitos, continuidad de lecturas y recuperación. |

E1–E3 requieren Pagos P2 real y coordinación entre P2/P3/P4. No se ejecutan desde P4. E2 usa el
control publicado por P3, pero el flujo completo con cobro sigue dependiendo de P2. No se mutan
módulos de la Saga ni volúmenes compartidos desde P4.

## Entradas que debe entregar P2

Antes de ejecutar E1–E3, P2 debe acordar y entregar:

- Contrato interno, URL, health y versión desplegable de Pagos.
- Controles de falla y comparación disponibles: rechazo, timeout, lentitud, caída y recuperación,
  con el nombre exacto de cada control.
- Métricas y atribución de Circuit Breaker/Bulkhead, estados y ventanas de medición.
- Comportamiento de recuperación y criterio para distinguir rechazo confirmado de resultado en duda.
- Presupuesto de timeouts de Pagos y su relación con el deadline de Sales y el rate limit del
  Gateway.

Si P2 no entrega un control o una señal, el brazo correspondiente no se ejecuta. No se sustituye por
un toggle inventado ni por un mock runtime.

## Protocolo práctico

- Preflight de stock y de los controles de falla antes de cada serie.
- Misma tasa, concurrencia, datos y semilla entre brazos; registrar duración y warmup.
- Al menos tres iteraciones por brazo, sin mezclar E1, E2 y E3 en la misma serie.
- Medir rutas por separado: creación/cancelación, resumen, Pagos y lecturas de clientes.
- Reportar p50, p95, p99, `n` y tasa de error por ruta y brazo.
- Leer `GET /v1/customers` mientras falla Pagos/Despacho para comprobar continuidad.
- Distinguir un `429` del rate limit del Gateway de un fallback o rechazo de Pagos. Si el brazo no
  mide el fenómeno por rate limit, fallback o error de instrumentación, se invalida y se repite.
- Acordar thresholds/SLO antes de ejecutar; no moverlos después de ver resultados.
- No fabricar métricas, cargas ni respuestas. Si un brazo no se ejecutó, se declara ausente.

## Mediciones

- p50, p95 y p99 de latencia por solicitud y por escenario.
- Códigos HTTP/estado de negocio y tasa de éxito.
- Estado del Circuit Breaker (cerrado/abierto/semiabierto) cuando P2 lo exponga.
- Rechazos del Bulkhead y solicitudes rechazadas por rate limit, por separado.
- Continuidad de `GET /v1/customers` durante la falla.
- Stock final, idempotencia y número de efectos por orden.
- Repeticiones, warmup y duración de cada brazo.

El rate limit del Gateway no debe usarse como sustituto de Circuit Breaker/Bulkhead ni ocultar
sus rechazos. Si el rate limit interviene, se registra como variable separada.

## Esquema CSV

Cabecera prevista; no hay filas ni resultados fabricados en este documento:

```csv
timestamp,scenario,arm,repetition,warmup,request_count,latency_p50_ms,latency_p95_ms,latency_p99_ms,http_status,error_code,circuit_state,bulkhead_rejected,rate_limited,stock_final,idempotent_effects,notes
```

La cabecera actual basta para separar `rate_limited`, `circuit_state` y `bulkhead_rejected`. Si P2
expone un fallback de pago con un nombre propio, se añade una columna antes de ejecutar y se deja
vacía hasta tener datos reales. No se rellenan filas ficticias.

## Reproducibilidad

- Fijar versiones, imágenes, contratos y semillas antes de cada serie.
- Ejecutar warmup y al menos tres repeticiones por brazo; registrar la duración.
- Mantener la misma carga, datos y orden de pasos entre brazos.
- No mezclar E1, E2 y E3 en una misma serie.
- Guardar logs sólo con IDs de correlación y estados; nunca tokens, claves, cuerpos completos ni
  secretos.
- Separar artefactos de prueba de volúmenes persistentes. No borrar volúmenes para “limpiar”
  resultados.

## Ownership

P4 es responsable de la orquestación y la medición. P4 no implementa toggles de P2/P3, no ejecuta
SQL y no apaga la compensación en E2. La ejecución de E1–E3, los toggles de falla y las métricas
definitivas dependen de P2/P3 y de la coordinación previa.
