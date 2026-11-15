# T2-402/403 — plan de experimento (preparación, sin resultados)

Este documento prepara el experimento de protecciones de P2 y compensación de P3. No contiene
resultados, métricas observadas ni conclusiones. No se ejecutaron escenarios de falla porque los
contratos y módulos de P2/P3 todavía no están integrados. No se editan sus módulos desde P4.

## Hipótesis y controles

- **H1 — protección de fallas:** con Circuit Breaker y Bulkhead de P2, una dependencia lenta o
  caída debe acotar latencia y rechazos sin tumbar la continuidad de `GET /v1/customers`.
- **H2 — compensación:** si el último paso confirmado falla (Despacho), la Saga de P3 debe
  compensar en orden inverso los pasos anteriores. El control es el mismo flujo con éxito.
- **H3 — pico de Pagos:** una fuente Pagos lenta o caída debe activar las protecciones acordadas
  en P2 sin que el rate limit del Gateway oculte el Circuit Breaker o el Bulkhead.

Los contratos, endpoints, códigos y toggles definitivos de P2/P3 están pendientes. No se inventan
aquí. El plan usa los contratos internos actuales sólo como referencia:
[T2-INTERNAL-CONTRACTS.md](../architecture/T2-INTERNAL-CONTRACTS.md) y
[P4-SPEC.md](P4-SPEC.md).

## Escenarios

| ID | Escenario | Brazo A | Brazo B | Qué debe observarse |
|---|---|---|---|---|
| E1 | Éxito completo | Flujo normal | Flujo normal con protecciones P2 | Estado final confirmado y mismos efectos de negocio. |
| E2 | Falla en el último paso (Despacho) | Camino normal, sin falla | Falla de Despacho con compensación activa P3 | El stock y los pasos previos quedan en el estado acordado; no se duplican efectos. |
| E3 | Pagos lento o caído en pico | Sin protección | Circuit Breaker/Bulkhead P2 en entorno aislado y coordinado | Latencia acotada, rechazos explícitos, continuidad de lecturas y recuperación. |

E2 no compara un brazo “sin compensación”: no se desactivan invariantes de la Saga ni se añade
código P3 desde P4. La comparación con y sin protecciones se limita a E3, en un entorno P2
aislado y coordinado. No se mutan módulos de la Saga ni volúmenes compartidos desde P4.

E2 y E3 no se ejecutan antes de que P2/P3 publiquen contratos y módulos. El smoke P4 no es
evidencia de E1–E3.

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

## Reproducibilidad

- Fijar versiones, imágenes, contratos y semillas antes de cada serie.
- Ejecutar warmup y al menos tres repeticiones por brazo; registrar la duración.
- Mantener la misma carga, datos y orden de pasos entre brazos.
- No mezclar E1, E2 y E3 en una misma serie.
- Guardar logs sólo con IDs de correlación y estados; nunca tokens, claves, cuerpos completos ni
  secretos.
- Separar artefactos de prueba de volúmenes persistentes. No borrar volúmenes para “limpiar”
  resultados.

## Decisión pendiente

La ejecución, los toggles de falla y las métricas definitivas dependen de P2/P3. Hasta entonces
este plan es una preparación y no una garantía de comportamiento.
