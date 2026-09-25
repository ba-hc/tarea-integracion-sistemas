# RS-402 · Experimento: efecto del timeout ante un Inventory lento

Mide cómo el deadline gRPC de Sales protege al llamador cuando Inventory se vuelve lento, y
qué se paga por esa protección. Da evidencia empírica a [ADR-004](../../docs/adr/ADR-004-resilience.md)
y cubre la Competencia ABET 6.

## Hipótesis

> Un deadline de 800 ms acota la latencia observada por el llamador de `POST /v1/orders`
> cuando Inventory supera ese tiempo de respuesta, a costa de convertir esas solicitudes en
> respuestas 504 `INVENTORY_TIMEOUT`.

Se registra antes de medir, y se contrasta con los datos aunque el resultado la contradiga.

## Diseño

**Variable independiente.** Latencia inyectada con Toxiproxy en el salto Sales → Inventory:
`0, 250, 500, 750, 1000, 1500 ms`. El deadline congelado (800 ms) queda entre 750 y 1000, así
que el cambio de régimen debe verse entre esas dos condiciones.

**Segundo factor.** `INVENTORY_RPC_DEADLINE_MS`, en dos brazos:

| Brazo | Valor | Para qué |
|---|---|---|
| `con-deadline` | `800` | el comportamiento congelado en ADR-004 |
| `sin-deadline` | `60000` | línea base: cuánto espera Sales si nadie acota |

**Variable dependiente.** Latencia observada por el cliente (p50/p95/p99/máx) y distribución
de códigos HTTP.

6 latencias × 2 brazos × 3 repeticiones = **36 corridas** de 30 s. Unos 30 minutos en total.

### Qué se controla y por qué

- **`constant-arrival-rate`, no VUs constantes.** Mantiene fija la carga ofrecida aunque la latencia crezca.
  Con VUs constantes el throughput se desplomaría al subir la latencia y mediríamos el generador,
  no el efecto del deadline.
- **5 req/s**, por debajo de las 10 conexiones predeterminadas del pool PostgreSQL de Sales.
  Cada transacción retiene una conexión mientras espera a Inventory: con 1.500 ms inyectados,
  5 × 1,5 = 7,5 solicitudes concurrentes esperadas; 20 req/s saturaría el pool y mezclaría
  saturación con el efecto del deadline.
- **Warm-up de 5 s descartado** antes de cada corrida, para no medir el arranque en frío de
  conexiones, pool de la base de datos y JIT.
- **Misma pieza, misma cantidad (1), mismo cliente** durante todo el barrido.
- **`Idempotency-Key` única por iteración**, para que ninguna respuesta sea un replay de una
  orden anterior.
- **`jitter=0`** en el toxic: latencia determinista, no una distribución.
- **Tres repeticiones por condición**, para poder ver la dispersión y no confiar en una
  medición única.

### El riesgo del diseño: agotamiento de stock

`POST /v1/orders` descuenta stock de verdad; el barrido genera unas 2.700 órdenes medidas
por brazo (más 450 de warm-up). Si el stock se acaba, las respuestas pasan a 409
`INSUFFICIENT_STOCK` y la corrida deja de medir latencia para medir otra cosa. Por eso el
experimento usa una pieza sembrada con stock alto y **`run.sh` aborta en cuanto ve un solo
409**: es preferible cortar el barrido a guardar un resultado contaminado.

## Requisitos

En la máquina que ejecuta:

- `k6` ([instalación](https://grafana.com/docs/k6/latest/set-up/install-k6/)), `curl` y `bash`.
  En Windows los scripts se corren desde Git Bash.
- El stack de RepuestosSur levantado, con Toxiproxy interpuesto entre Sales e Inventory.

Del resto del equipo:

| Issue | Qué se necesita |
|---|---|
| RS-102 | Perfil de Compose con `toxiproxy`; Sales debe leer `INVENTORY_GRPC_URL` y `INVENTORY_RPC_DEADLINE_MS` del entorno |
| RS-201 | Una pieza en el seed con UUID fijo y `stock_available >= 50000` |
| RS-301 | Una API key con rol `operator` inyectable por variable de entorno |

El cliente de prueba no es una dependencia: `run.sh` lo crea con `POST /v1/customers`.

## Cómo reproducirlo

Cada brazo es una ejecución completa, porque cambiar el deadline exige recrear Sales. El
script no cambia el deadline: se configura en el stack y se le pasa a `run.sh` para etiquetar
las filas.

Desde la raíz del repositorio:

```bash
export SALES_BASE_URL=http://localhost:3000
export API_KEY_OPERATOR=<key con rol operator>
export SALES_API_KEY="$API_KEY_OPERATOR"
export EXPERIMENT_PART_ID=<uuid de la pieza sembrada>

# En ambos brazos, Sales debe atravesar Toxiproxy.
# Brazo 1 - con deadline (el comportamiento congelado)
INVENTORY_GRPC_URL=toxiproxy:50051 INVENTORY_RPC_DEADLINE_MS=800 \
  docker compose --profile experiment up -d --build --wait
DEADLINE_MS=800 bash experiments/timeout/scripts/run.sh

# Brazo 2 - linea base sin deadline efectivo
INVENTORY_GRPC_URL=toxiproxy:50051 INVENTORY_RPC_DEADLINE_MS=60000 \
  docker compose --profile experiment up -d --force-recreate --wait sales-api
DEADLINE_MS=60000 bash experiments/timeout/scripts/run.sh
```

`run.sh` regenera `results/summary.csv` con todas las corridas acumuladas en `results/runs/`,
así que tras el segundo brazo el CSV contiene los 36 registros.

Variables opcionales: `LATENCIES` (default `0 250 500 750 1000 1500`), `REPS` (`3`),
`RATE` (`5`), `DURATION` (`30s`), `WARMUP` (`5s`).

Para una prueba de humo rápida antes del barrido real:

```bash
LATENCIES="0 1000" REPS=1 DURATION=10s DEADLINE_MS=800 bash experiments/timeout/scripts/run.sh
```

## Resultados

- `results/summary.csv` — una fila por corrida, listo para tabla o gráfico.
- `results/runs/<brazo>_<latencia>_<rep>.json` — resumen completo de k6, evidencia cruda.

Columnas de `summary.csv`:

| Columna | Significado |
|---|---|
| `deadline_ms` | brazo: 800 o 60000 |
| `injected_latency_ms` | latencia inyectada por Toxiproxy |
| `rep` | número de repetición (1..3) |
| `rate_rps`, `duration` | carga ofrecida y duración de la corrida |
| `http_reqs`, `rps_actual` | solicitudes completadas y throughput real |
| `status_201` | órdenes confirmadas |
| `status_409` | conflictos; **cualquier valor > 0 invalida la corrida** |
| `status_503` | `INVENTORY_UNAVAILABLE` |
| `status_504` | `INVENTORY_TIMEOUT`, el efecto que buscamos |
| `status_other` | cualquier otro código; señal de que algo se salió del diseño |
| `p50_ms`, `p95_ms`, `p99_ms`, `max_ms` | latencia observada por el cliente |

Ejecución completada: 6 latencias × 2 deadlines × 3 repeticiones, 30 s por corrida, 5 req/s,
warm-up de 5 s descartado. La tabla resume las tres repeticiones por condición; `p95` es la
mediana de los tres p95 y `máx.` el máximo observado.

| Deadline | Latencia | Solicitudes | 201 | 504 | p95 (ms) | Máx. (ms) |
|---:|---:|---:|---:|---:|---:|---:|
| 800 | 0 | 451 | 451 | 0 | 28.47 | 40.37 |
| 800 | 250 | 452 | 452 | 0 | 287.30 | 295.44 |
| 800 | 500 | 453 | 453 | 0 | 514.90 | 539.04 |
| 800 | 750 | 451 | 451 | 0 | 779.70 | 792.37 |
| 800 | 1000 | 452 | 0 | 452 | 825.75 | 835.14 |
| 800 | 1500 | 453 | 0 | 453 | 820.90 | 836.00 |
| 60000 | 0 | 452 | 452 | 0 | 27.45 | 37.35 |
| 60000 | 250 | 452 | 452 | 0 | 283.36 | 292.55 |
| 60000 | 500 | 453 | 453 | 0 | 513.54 | 536.29 |
| 60000 | 750 | 451 | 451 | 0 | 763.33 | 780.37 |
| 60000 | 1000 | 453 | 453 | 0 | 1013.97 | 1027.59 |
| 60000 | 1500 | 452 | 452 | 0 | 1514.10 | 1536.30 |

En el brazo de 800 ms se completaron 2.712 solicitudes: 1.807 HTTP 201 y 905 HTTP 504;
no hubo 409, 503 ni otros códigos. Las seis corridas de 1.000/1.500 ms devolvieron 504 en
el 100 % de las solicitudes. En el brazo de 60.000 ms, las 2.713 solicitudes devolvieron 201.

**Conclusión.** Los datos apoyan la hipótesis: el timeout separa 750 de 1.000 ms inyectados
y evita que la latencia del Inventory lento siga creciendo como en la línea base. No es un
límite duro de 800 ms para HTTP: el máximo observado fue 836 ms porque el deadline se aplica
al RPC y la respuesta HTTP añade el manejo del error y su propio recorrido.

## Limitaciones conocidas

Van en el informe junto con las conclusiones; reconocerlas es parte de lo que se evalúa.

1. **El toxic de Toxiproxy no es exactamente latencia de red.** Actúa sobre el stream TCP
   `downstream`. Como gRPC multiplexa sobre una conexión HTTP/2 persistente, la latencia
   efectiva por RPC puede no ser idéntica al valor nominal del toxic. Los valores son
   consistentes entre condiciones, que es lo que el experimento necesita, pero no deben
   leerse como una medición de red real.
2. **Todo corre en una sola máquina**, así que el generador de carga compite por CPU con los
   servicios y las bases de datos. Los números absolutos dependen del hardware; lo comparable
   es la diferencia entre condiciones, no el valor aislado.
3. **Docker Desktop sobre Windows añade una capa de virtualización** que desplaza las
   latencias base hacia arriba respecto de Linux nativo.
4. **5 req/s evita saturar el pool PostgreSQL predeterminado de 10 conexiones de Sales**
   incluso con 1.500 ms inyectados; no mide capacidad ni dónde está el cuello de botella.
5. **El deadline se aplica por RPC, no por solicitud HTTP.** La creación de una orden hace una
   sola llamada a `ReserveStock`, así que en este escenario coinciden; en un flujo con varias
   llamadas a Inventory dejarían de coincidir.
6. **3 repeticiones permiten ver dispersión, no hacer inferencia estadística.** No se reportan
   intervalos de confianza.

## Estado

Barrido ejecutado el 2026-09-25 con Docker Compose y `grafana/k6:0.57.0`: 36 corridas
completas y cero códigos ajenos a 201/504. Los resultados fila por fila están en
[`results/summary.csv`](results/summary.csv); el análisis, límites y guion de defensa están en
[`docs/report/DEMO.md`](../../docs/report/DEMO.md) (RS-403).
