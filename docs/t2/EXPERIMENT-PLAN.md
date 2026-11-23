# T2-402/403 — experimento observado

**Estado (2026-11-23):** E1 full, E2 full con fallo de Despacho y E3 de continuidad ejecutados en
`repuestossur-p4-final`, puerto `8082`. Las cifras, comandos y límites están en
[VERIFICATION.md](VERIFICATION.md), §10. Este documento describe el diseño observado; no es un
benchmark de Pagos ni un SLO.

## Qué se ejecutó

- **E1 — éxito completo:** flujo normal `stock,payment,dispatch` con creación `201 CONFIRMED`,
  replay idempotente, resumen `200 partial:false` y doble cancelación con reembolso.
- **E2 — fallo en el último paso:** full con `DISPATCH_FAIL_CREATE=true`; `503
  DISPATCH_UNAVAILABLE`, replay con el mismo código/mensaje, cero órdenes públicas y compensación de
  Pagos y stock.
- **E3 — continuidad:** cuatro brazos × tres repeticiones. Bulkhead protegido/sin protección con
  simulador `slow`; Circuit Breaker protegido/sin protección con simulador `down`. Cada brazo midió
  POST de negocio y `GET /v1/customers` en paralelo.

No se ejecutó un A/B “normal sin protecciones” de P4: E1 sólo cubre el camino normal. E2 no desactiva
la Saga; usa el control de fallo de Despacho publicado por P3. Las 18 corridas directas de P2 son
externas a E3 y se citan con atribución en
[experiments/payments](../../experiments/payments/README.md).

## Hipótesis y lectura

- **H1 — protección de fallas:** con Circuit Breaker y Bulkhead de P2, una pasarela lenta o caída
  debe producir rechazos explícitos y mantener la continuidad de `GET /v1/customers`. Se observó el
  mecanismo; no se fijó un umbral de latencia ni se demuestra un SLO.
- **H2 — compensación:** si falla Despacho, la Saga debe reembolsar el cobro y liberar el stock sin
  exponer una orden pública. Se observó en E2; no se probó atomicidad de P1 ni orden temporal de
  efectos.
- **H3 — pico de Pagos:** una fuente lenta o caída debe activar las protecciones P2 sin que el rate
  limit del Gateway oculte el fenómeno. Se observó con 0 respuestas `429`; la muestra es pequeña y no
  es capacidad.

## Escenarios

| ID | Escenario | Brazo | Evidencia |
|---|---|---|---|
| E1 | Éxito completo | Full normal, sin falla | §10.3: creación, replay, resumen y cancelación |
| E2 | Falla en Despacho | Full con `DISPATCH_FAIL_CREATE=true`, Saga activa | §10.3: `503`, replay estable, cero órdenes, compensación |
| E3 | Pasarela lenta o caída | Bulkhead y Circuit Breaker, protegido vs. apagado | §10.4: estados, rechazos, `n` y percentiles |

Los brazos de planificación que no se ejecutaron no se presentan como evidencia. E3 no compara la
Saga ni Despacho: sólo las protecciones de Pagos.

## Controles usados

- La pasarela simulada se configura en caliente con `GET/PUT /admin/config` mediante `docker compose
  exec` dentro de `payment-gateway-sim`. No se publica un puerto de administración.
- El estado de Pagos se lee con `GET /internal/v1/resilience` mediante `docker compose exec` dentro
  de `payments-api`.
- Flags de los brazos: `PAYMENTS_CIRCUIT_BREAKER_ENABLED`, `PAYMENTS_BULKHEAD_ENABLED`,
  `PAYMENTS_BULKHEAD_MAX_CONCURRENT` y `PAYMENTS_GATEWAY_TIMEOUT_MS`. El timeout se fija en `1200 ms`
  en ambos brazos.
- No se inventaron toggles de P2/P3, no se ejecutó SQL, no se leyeron bases ajenas y no se usó el
  rate limit para eludir ni sustituir las protecciones.

## Protocolo ejecutado

- Tres repeticiones por brazo; warmup de una venta normal y su cancelación por repetición.
- `payments-api` se recreó antes de cada repetición para limpiar contadores y fijar flags/timeout. No
  se reinició el simulador.
- Bulkhead: simulador `slow` con `650 ms`, cap experimental `2`, ráfaga de 6 ventas simultáneas y
  Circuit Breaker apagado.
- Circuit Breaker: simulador `down`, 8 POST secuenciales y Bulkhead apagado.
- `GET /v1/customers` se programó en paralelo a la ráfaga o a los POST.
- La corrida fue exclusiva y serial en `repuestossur-p4-final`; no se mezcló con smoke, carga ni otro
  proyecto.
- Se midieron 84 POST con cuerpo de negocio y 54 GET de clientes, con 0 respuestas `429`.
- La latencia es HTTP del host alrededor de cada solicitud; se reportan p50/p95/p99, `n` y conteos
  por ruta y brazo. No se usó un umbral duro ni se movió después de ver resultados.

## Datos y JSON

Los runners escriben un único JSON en stdout y los logs en stderr. No se versionan JSON, IDs, tokens
ni logs crudos. Para obtener un resumen:

```bash
P4_TEST_PROJECT=repuestossur-p4-final \
P4_TEST_PORT=8082 \
node tests/t2/p4-independent.mjs --no-build \
  | jq '{status, modes, dispatchFailure, restore}'
```

```bash
P4_TEST_PROJECT=repuestossur-p4-final \
P4_TEST_PORT=8082 \
node tests/t2/p4-continuity.mjs \
  | jq '{status, params, arms: [.arms[] | {name, protected, aggregate, repetitions: (.repetitions | length)}], restore}'
```

Los campos útiles de E3 son `params`, `arms[].protected`, `arms[].aggregate.post`,
`arms[].aggregate.get`, `arms[].repetitions[].resilience` y `restore`. Las tablas reales están en
[VERIFICATION.md](VERIFICATION.md), §10; no se mantiene un CSV con filas ficticias.

## Límites

- Muestras pequeñas: 4 brazos × 3 repeticiones; no es SLO, capacidad ni benchmark de Pagos.
- Las latencias POST agregan respuestas `201` y `503`; no miden sólo cobros aprobados.
- No se observó `HALF_OPEN` ni recuperación sostenida bajo carga medida más allá de la restauración.
- En los brazos de Circuit Breaker, el warmup añade dos llamadas exitosas al historial; explica la
  apertura tras tres fallas sin cambiar el mínimo configurado.
- `GetPart` es una sonda de observabilidad; no prueba atomicidad de P1 ni el orden temporal de los
  efectos.
- No se ejecutó CI de GitHub ni una auditoría npm nueva.
- La integración final en el Compose raíz y la CI del grupo siguen pendientes de coordinación.

## Reproducibilidad

- Fijar proyecto, puerto, imágenes, contratos y flags antes de la serie.
- Ejecutar en exclusiva, sin smoke ni carga concurrente.
- No borrar volúmenes para “limpiar” resultados; el runner restaura configuración, cancela ventas y
  verifica stock.
- No publicar IDs, tokens, claves, cuerpos completos ni logs crudos.
- Las corridas de P2 se citan desde su propio documento y no se mezclan con los totales de P4.

## Ownership

P4 es responsable de la orquestación y la medición. P4 no implementa toggles de P2/P3, no ejecuta SQL
y no apaga la compensación en E2. La integración en el Compose raíz, la CI del grupo y la publicación
de la demo son responsabilidades de coordinación.
