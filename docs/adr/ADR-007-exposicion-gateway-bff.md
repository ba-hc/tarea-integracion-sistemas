# ADR-007 - Exposición: API Gateway único y BFF web sin lógica de negocio

**Estado:** Aceptada (T2-401, T2-403). Detalle de rutas y contratos en [P4-SPEC](../t2/P4-SPEC.md).

## Contexto

El encargo pide un API Gateway como único punto de entrada, autenticación central con token, rate
limiting por cliente y al menos un BFF que agregue dos o más servicios. En la T1, Ventas estaba
publicada directamente en el host con `X-API-Key`. En la T2 hay cuatro servicios de dominio más la
pasarela, y la pantalla web de «mi compra» necesita el estado del pago y del despacho de una venta.

## Decisión 1: el Gateway es la única puerta y no tiene lógica de negocio

- Es el único servicio con `ports` en `docker-compose.yml`; la CI falla si otro servicio publica un
  puerto. Ventas, Inventario, Pagos, Despacho, la pasarela y el BFF quedan en la red interna.
- Hace sólo lo transversal: valida un JWT HS256 (firma, `iss`, `aud`, `exp`), decide por rol
  (`reader` lee, `operator` escribe), limita por cliente (ventana de 60 s, 60 peticiones por `sub`,
  `429 RATE_LIMIT_EXCEEDED` con `Retry-After`), aplica una allowlist de rutas y límites de tamaño, y
  reenvía con un timeout por destino.
- **No** reserva, no cobra, no compensa, no conoce precios ni estados de orden y no tiene base de
  datos. Si mañana cambia la Saga, el Gateway no cambia.
- Los servicios confían en que la petición ya pasó por la puerta. Ventas conserva su `X-API-Key` de
  la T1 como credencial servicio a servicio, que el Gateway inyecta según el rol; el cliente externo
  nunca la ve.

Alternativa descartada: validar el JWT en cada servicio. Duplica la configuración del secreto en
cinco lugares y no aporta nada mientras los servicios no sean alcanzables desde fuera.

## Decisión 2: un BFF por cliente, de sólo lectura

- `web-bff` sirve al cliente web: `GET /web/v1/orders/{id}/summary` consulta en paralelo Pagos y
  Despacho (1,5 s cada uno) y devuelve una sola respuesta recortada a lo que la pantalla necesita
  (estado del pago y del despacho, ítems), sin montos internos ni campos de auditoría.
- Degradación elegante: si una fuente falla o tarda, responde `200` con `partial: true` y la fuente
  marcada como `unavailable`/`timeout`; sólo devuelve error si no puede decir nada útil.
- No escribe: crear o cancelar sigue siendo trabajo de Ventas (dueña de la Saga). Así el BFF no
  puede dejar una venta a medias.
- Si mañana existe una app móvil, tendrá su propio BFF con su propia forma de respuesta; no se
  amplía éste con parámetros por cliente.

## Decisión 3: sin resiliencia duplicada en la exposición

El Circuit Breaker y el Bulkhead viven en Pagos, junto a la dependencia frágil
([ADR-006](ADR-006-resiliencia-pagos.md)). Gateway y BFF sólo tienen deadlines y el rate limit.
Repetir un circuito en el Gateway ocultaría cuál dependencia falló y abriría por fallas que no son
de la pasarela.

## Consecuencias

- `docker compose up` deja un solo puerto en el host: `127.0.0.1:8080`.
- Para operar el interior (cambiar el modo de la pasarela, leer el estado del circuito) se usa
  `docker compose exec`, como haría un operador; esas rutas `/internal` y `/admin` nunca pasan por
  el Gateway.
- El rate limit es en memoria y por instancia: suficiente para una instancia; con varias haría falta
  un contador compartido.
- La suite black-box de la T1 usa `docker-compose.dev.yml`, que vuelve a publicar Ventas en loopback
  sólo para pruebas.
