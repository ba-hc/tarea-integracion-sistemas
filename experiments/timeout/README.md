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

- **`constant-arrival-rate`, no VUs constantes.** Es la decisión que hace válido el
  experimento. Mantiene la carga ofrecida fija (20 req/s) aunque la latencia crezca. Con VUs
  constantes el throughput se desplomaría al subir la latencia, y estaríamos midiendo el
  efecto del generador de carga en vez del efecto del deadline.
- **Warm-up de 5 s descartado** antes de cada corrida, para no medir el arranque en frío de
  conexiones, pool de la base de datos y JIT.
- **Misma pieza, misma cantidad (1), mismo cliente** durante todo el barrido.
- **`Idempotency-Key` única por iteración**, para que ninguna respuesta sea un replay de una
  orden anterior.
- **`jitter=0`** en el toxic: latencia determinista, no una distribución.
- **Tres repeticiones por condición**, para poder ver la dispersión y no confiar en una
  medición única.

### El riesgo del diseño: agotamiento de stock

`POST /v1/orders` descuenta stock de verdad, y el barrido completo genera unas 10.000 órdenes
por brazo. Si el stock se acaba, las respuestas pasan a 409 `INSUFFICIENT_STOCK` y la corrida
deja de medir latencia para medir otra cosa. Por eso el experimento usa una pieza sembrada con
stock alto y **`run.sh` aborta en cuanto ve un solo 409**: es preferible cortar el barrido a
guardar un resultado contaminado.

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

```bash
export SALES_BASE_URL=http://localhost:3000
export SALES_API_KEY=<key con rol operator>
export EXPERIMENT_PART_ID=<uuid de la pieza sembrada>

# Brazo 1 - con deadline (el comportamiento congelado)
INVENTORY_RPC_DEADLINE_MS=800 docker compose --profile experiment up -d --build
DEADLINE_MS=800 ./scripts/run.sh

# Brazo 2 - linea base sin deadline efectivo
INVENTORY_RPC_DEADLINE_MS=60000 docker compose --profile experiment up -d --force-recreate sales-api
DEADLINE_MS=60000 ./scripts/run.sh
```

`run.sh` regenera `results/summary.csv` con todas las corridas acumuladas en `results/runs/`,
así que tras el segundo brazo el CSV contiene los 36 registros.

Variables opcionales: `LATENCIES` (default `0 250 500 750 1000 1500`), `REPS` (`3`),
`RATE` (`20`), `DURATION` (`30s`), `WARMUP` (`5s`).

Para una prueba de humo rápida antes del barrido real:

```bash
LATENCIES="0 1000" REPS=1 DURATION=10s DEADLINE_MS=800 ./scripts/run.sh
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

La lectura esperada: en el brazo con deadline, `max_ms` debería quedar acotado cerca de los
800 ms y los 504 deberían aparecer al pasar de 750 a 1000 ms de latencia inyectada; en el
brazo sin deadline, la latencia debería seguir creciendo con la latencia inyectada y casi no
debería haber 504. Si los datos no muestran eso, se reporta lo que muestran.

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
4. **20 req/s es carga moderada, no saturación.** El experimento mide el efecto del timeout,
   no dónde está el cuello de botella del sistema; eso sería otro experimento.
5. **El deadline se aplica por RPC, no por solicitud HTTP.** La creación de una orden hace una
   sola llamada a `ReserveStock`, así que en este escenario coinciden; en un flujo con varias
   llamadas a Inventory dejarían de coincidir.
6. **3 repeticiones permiten ver dispersión, no hacer inferencia estadística.** No se reportan
   intervalos de confianza.

## Estado

El arnés está completo y la hipótesis registrada. El barrido **no se ha ejecutado todavía**:
depende de que estén mergeados RS-102, RS-201/202 y RS-301/302/303. `run.sh` crea `results/`
en la primera corrida, y esos datos son los que van al informe (RS-403).
