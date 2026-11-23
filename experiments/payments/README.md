# T2-203 · Experimento: Pagos bajo carga con la pasarela lenta o caída

Mide qué aportan el timeout, el Circuit Breaker y el Bulkhead de Pagos ([ADR-006](../../docs/adr/ADR-006-resiliencia-pagos.md)) cuando la pasarela externa se degrada en un pico de ventas, y si las demás operaciones de Pagos siguen respondiendo.

## Hipótesis

Registradas antes de medir:

- **H1:** con la pasarela lenta (3 s), las protecciones acotan la latencia de un cobro muy por debajo de los 2 s que espera Ventas y convierten la mayoría de las solicitudes en rechazos rápidos y seguros (`503 PAYMENT_CHARGE_REJECTED`). Sin protecciones, todos los cobros agotan el plazo del cliente con el resultado en duda.
- **H2:** con la pasarela caída, el Circuit Breaker deja de enviarle tráfico: la pasarela recibe un puñado de llamadas en lugar de una por venta.
- **H3:** las consultas `GET` de Pagos siguen respondiendo igual en todos los escenarios, porque no dependen de la pasarela.

## Diseño

| Factor | Niveles |
|---|---|
| Brazo | `protected`: Circuit Breaker + Bulkhead (8) + timeout 1,2 s (valores por defecto). `unprotected`: sin circuito ni bulkhead y timeout de 30 s. |
| Pasarela | `normal` (20 ms), `slow` (responde a los 3 s, pero aplica el cobro al recibirlo), `down` (`503 GATEWAY_UNAVAILABLE` sin aplicar nada). |
| Repeticiones | 3 por combinación: 2 × 3 × 3 = **18 corridas** de 30 s. |

Carga por corrida (k6 2.4.0, `constant-arrival-rate`):

- **charges:** 20 cobros nuevos por segundo, cada uno de una venta distinta. El plazo del cliente es 2 s, el mismo que usa Ventas con Pagos, así que la latencia medida es la que vería la Saga.
- **reads:** 5 `GET` por segundo de un cobro sembrado antes de degradar la pasarela.
- **probe:** 2 lecturas por segundo de `/internal/v1/resilience`, que forman la línea de tiempo del circuito.

Controles: Pagos se recrea antes de cada corrida, así que el circuito empieza cerrado y los contadores en cero. La carga, los datos y el orden de los pasos son iguales en ambos brazos. Los efectos reales se cuentan en la pasarela (`gateway_calls` y `gateway_charges_applied`), no en el cliente.

## Cómo reproducirlo

Requiere Docker Compose y Node.js en el host (Node sólo lee los JSON). Desde la raíz del repositorio:

```bash
bash experiments/payments/scripts/run.sh
# Subconjunto, por ejemplo:
ARMS=protected SCENARIOS=slow REPS=1 DURATION=10s bash experiments/payments/scripts/run.sh
```

El script levanta `payments-db`, `payment-gateway-sim` y `payments-api`, corre k6 dentro de la red de Compose (servicio `k6-payments`, perfil `payments-experiment`) y agrega una fila por corrida a `results/summary.csv`. Por corrida deja el resumen de k6 (`runs/<id>.json`), la línea de tiempo del circuito (`runs/<id>_timeline.csv`) y el estado final de las protecciones (`runs/<id>_resilience.json`). No publica puertos ni borra volúmenes. Al terminar, devuelve Pagos a su configuración por defecto.

## Resultados

Medidos el 2026-11-23 en Linux arm64 (4 CPU), con Docker 29.10.0 y Compose v5.8.0. Datos completos en [results/summary.csv](results/summary.csv). Los rangos van de la repetición más baja a la más alta.

| Brazo | Pasarela | Cobrados | En duda para el cliente (202 o timeout) | Rechazo rápido (503) | p50 cobro | p95 cobro | p99 cobro | Llamadas a la pasarela | p95 `GET` |
|---|---|---|---|---|---|---|---|---|---|
| protected | normal | 600–601 (100 %) | 0 | 0 | 29,6–29,8 ms | 31,7–32,7 ms | 33,3–36,2 ms | 600–601 | 3,6–3,8 ms |
| unprotected | normal | 600–601 (100 %) | 0 | 0 | 29,5–29,6 ms | 31,4–33,3 ms | 33,5–35,5 ms | 600–642¹ | 3,6–3,9 ms |
| protected | slow | 0 | 13–15 (202) | 585–588 | 6,0–6,4 ms | 7,9–9,4 ms | 1212–1215 ms | 15 | 4,1–4,9 ms |
| unprotected | slow | 0 | 600–601 (timeout 2 s) | 0 | 2000 ms | 2000,7–2000,8 ms | 2000,9 ms | 600–601 | 3,9–4,3 ms |
| protected | down | 0 | 0 | 601 | 6,1–6,2 ms | 7,8–9,0 ms | 11,8–28,4 ms | 9–10 | 3,8–4,4 ms |
| unprotected | down | 0 | 0 | 600–601 | 29,4–29,7 ms | 31,5–32,2 ms | 34,0–35,3 ms | 600–601 | 3,5–3,9 ms |

¹ Las 41 llamadas de más en `unprotected/normal` r1 son consultas del reconciliador. Resolvió los 41 cobros que habían quedado `PENDING` en las tres corridas `protected/slow` (15 + 13 + 13). Al final de la serie, la base de Pagos tenía 0 registros `PENDING`.

Estado de las protecciones al final de cada corrida `protected`:

| Pasarela | Aperturas del circuito | Rechazos del circuito | Rechazos del bulkhead (pico en vuelo) |
|---|---|---|---|
| slow | 5 | 574–577 | 17–18 (8) |
| down | 6–7 | 602–603 | 0 (1) |

Ninguna corrida tuvo errores en las lecturas, iteraciones descartadas por k6 ni respuestas fuera de las categorías esperadas.

## Análisis

**H1 se cumple.** Con la pasarela lenta y sin protecciones, los 600 cobros de cada corrida agotaron los 2 s del cliente. Además, la pasarela **aplicó los 600**: el dinero se cobró, pero quien llama no lo sabe. Para la Saga son 600 ventas en duda, con el stock retenido hasta que un reintento o el recuperador las resuelva.

Con protecciones, la mediana fue de 6 ms y el p95 de 9 ms. En el primer segundo y medio, el bulkhead mantuvo 8 llamadas en vuelo y rechazó otras 17–18. Las 13–15 que llegaron a la pasarela agotaron el timeout de 1,2 s (por eso el p99 queda en 1,2 s, debajo de los 2 s de Ventas) y abrieron el circuito. Desde ahí, el resto fue `503 PAYMENT_CHARGE_REJECTED`, que garantiza que no hubo cobro, así que Ventas puede liberar el stock al instante. Los cobros que sí quedaron `PENDING` coinciden uno a uno con los que la pasarela aplicó (`gateway_charges_applied`), y el reconciliador los resolvió después a `CHARGED`.

En la línea de tiempo (`runs/protected_slow_r1_timeline.csv`), el circuito pasa a `OPEN` hacia 1,5 s y a `HALF_OPEN` cada 5 s. Como la pasarela sigue lenta, la sonda falla y el circuito vuelve a abrirse: 5 aperturas en 30 s.

**H2 se cumple.** Con la pasarela caída, ambos brazos rechazaron el 100 % sin cobrar, porque la pasarela confirma que no aplicó nada. La diferencia está en la carga sobre la dependencia que falla: sin protecciones, la pasarela recibió una llamada por venta (≈600 por corrida). Con el circuito, recibió 9–10: las 5 que lo abren más una sonda cada 5 s. El rechazo además fue unas 5 veces más rápido (p50 de 6 ms frente a 29 ms), porque no espera a la pasarela.

**H3 se cumple, pero no distingue los brazos.** Las lecturas mantuvieron un p95 de entre 3,5 y 4,9 ms y cero errores en las 18 corridas, también sin protecciones. Pagos atiende el `GET` desde su propia base y, en este volumen (unas 60 llamadas en vuelo hacia la pasarela lenta: 20/s × 3 s), esperar a la pasarela no agotó ningún recurso compartido. El aislamiento de lecturas viene del diseño (las consultas no tocan la pasarela), no del Bulkhead. Con más carga o con más llamadas lentas en vuelo, el pool de sockets y la memoria podrían empezar a importar. Eso no se midió aquí.

**Costo de las protecciones.** Con la pasarela sana, los dos brazos son indistinguibles (p95 de unos 32 ms y ningún rechazo): el bulkhead nunca superó 1 llamada en vuelo. El costo aparece en la recuperación. Con el circuito abierto, una pasarela que vuelve tarda hasta 5 s (`PAYMENTS_CB_OPEN_MS`) en recibir tráfico de nuevo, y durante ese lapso se rechazan ventas que habrían funcionado.

## Límites

- La pasarela es simulada y responde con latencias deterministas. No hay variabilidad de red ni distribución de latencias.
- La carga va directo a Pagos. El efecto sobre la venta completa (Saga, Gateway y BFF) bajo carga es parte de T2-402.
- Se midió con una sola instancia de Pagos y en una sola máquina, donde el generador de carga comparte CPU con el sistema.
