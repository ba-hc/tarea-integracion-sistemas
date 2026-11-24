# Evidencia de la T2 (corrida end-to-end de la CI)

Estos archivos son el artefacto `evidencia-t2-45446846259` del job **T2 end-to-end scenarios (single docker
compose up)** de la [corrida 45446846259](https://github.com/ba-hc/tarea-integracion-sistemas/actions/runs/45446846259)
sobre el commit `e4c7f90` (ver [`run.json`](run.json)). El job levanta el `docker-compose.yml` raíz, sin overlays,
y ejecuta:

```bash
node scripts/demo/escenarios.mjs todo --out evidencia-ci
```

Todas las cifras del [informe](../informe/INFORME-T2.pdf) y del video salen de estos archivos o de
`experiments/payments/results/` (experimento k6). Para regenerarlos en otra máquina, ver el README raíz.

| Archivo | Qué contiene |
|---|---|
| `exposicion.json` | Servicios levantados, puertos publicados (sólo `api-gateway`), 401/403 y rate limit (70 GET → 60 × 200 y 10 × 429). |
| `escenario1-exito.json` | Venta `201 CONFIRMED`, reintento con la misma key, conflicto `409`, bitácora de la Saga, stock y cobros antes/después, resumen del BFF. |
| `escenario2-compensacion.json` | Despacho rechazando: `503 DISPATCH_UNAVAILABLE`, bitácora con compensaciones en orden inverso (reembolso → liberación), stock 199 → 199, 1 cobro y 1 reembolso, orden pública `404`. |
| `escenario3-cascada.json` | Brazos con y sin protecciones: pasarela lenta + pico de 24 ventas, pasarela caída + 10 ventas, recuperación, estado del circuito y del bulkhead, sondas de otras operaciones, consistencia final y log del circuito. |
| `compose-ps.txt` | `docker compose ps` al terminar: once servicios sanos, sólo el Gateway con puerto en el host. |
| `compose.log` | Logs de todos los contenedores durante la corrida (sin códigos de color). |

## Resumen

| Escenario | Con protecciones | Sin protecciones |
|---|---|---|
| 3a · pasarela lenta (3 s) + 24 ventas simultáneas | 8 × `504` (las que dejó pasar el bulkhead) y 16 × `503` inmediatos; circuito abre; venta p50 452 ms; la pasarela aplicó 8 cobros que se reembolsaron | 24 × `504` tras ≈2,3 s; la pasarela aplicó 24 cobros que la Saga tuvo que reembolsar |
| 3b · pasarela caída, 10 ventas | 0 llamadas llegan a la pasarela (circuito abierto) | 10 de 10 llegan a la pasarela |
| Otras operaciones durante el pico | clientes p95 25 ms, resumen BFF p95 38 ms, todo `200` | clientes p95 24 ms, resumen BFF p95 90 ms, todo `200` |
| Recuperación | primera venta aceptada a los 3,2 s (espera la sonda) | 0,06 s |
| Consistencia | stock descontado = cobros netos = ventas confirmadas (1) | igual (1) |
