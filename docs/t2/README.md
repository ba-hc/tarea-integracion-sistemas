# P4: Gateway y BFF — reproducción local

P4 queda cerrado en su modo overlay local. Gateway y BFF no cambiaron su runtime en esta entrega:
la exposición sigue siendo la misma y ahora se verifica contra Pagos P2 **real** y la pasarela de
pagos **simulada oficial**. No hay dinero real.

El Compose raíz conserva `SAGA_STEPS=stock` por defecto y ya contiene P1–P3. El overlay P4 agrega
Gateway y BFF; la demo y las pruebas completas activan `stock,payment,dispatch` de forma explícita.
La integración final en el Compose raíz y la CI del grupo siguen pendientes de coordinación. La
evidencia real está en [VERIFICATION.md](VERIFICATION.md), §10.

## Requisitos

- Node.js 24 LTS. La corrida final usó `24.21.0`.
- Docker 29.9.0 y Docker Compose 5.6.0; Linux x86_64.
- Proyecto aislado `repuestossur-p4-final`, puerto loopback `8082` y 11 servicios.
- Siete imágenes construidas para ese mismo proyecto: Sales, Inventory, Dispatch, Pagos,
  pasarela simulada, Gateway y BFF.
- Secretos en variables de entorno o en un `.env.p4` local ignorado por Git, con permisos
  restrictivos (`0600` recomendado). No se imprimen valores.

Sólo se publica el Gateway en `127.0.0.1:8082`. Pagos, la pasarela simulada, BFF, Sales, Inventory,
Dispatch y las bases quedan internos. Tampoco se publican puertos de administración ni de bases de
prueba, incluso con perfiles.

## Configuración local

Genera el secreto JWT y las claves internas sólo en la terminal:

```bash
export GATEWAY_JWT_SECRET="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
export API_KEY_READER="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
export API_KEY_OPERATOR="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
```

No exportes `GATEWAY_SALES_API_KEY_READER` ni `GATEWAY_SALES_API_KEY_OPERATOR` para el overlay: el
Compose inyecta en el Gateway `API_KEY_READER` y `API_KEY_OPERATOR`, las mismas que usa Sales. No
publiques tokens, claves ni secretos en logs, capturas o documentos.

Si usas `.env.p4`:

```bash
chmod 600 .env.p4
```

El runner lo acepta sólo como entrada, si es un archivo regular sin permisos de grupo u otros. No lo
crea, no lo copia y no imprime sus valores. Sin `.env.p4`, usa los secretos exportados y desactiva el
`.env` genérico para no cargar perfiles ni archivos no solicitados.

## Runner aislado

Para un proyecto nuevo, desde la raíz, deja que el runner construya las imágenes:

```bash
P4_TEST_PROJECT=repuestossur-p4-final \
P4_TEST_PORT=8082 \
node tests/t2/p4-independent.mjs
```

Si las imágenes ya existen **para ese mismo proyecto**, puedes ahorrar el build:

```bash
P4_TEST_PROJECT=repuestossur-p4-final \
P4_TEST_PORT=8082 \
node tests/t2/p4-independent.mjs --no-build
```

`--no-build` no reutiliza imágenes de otro `P4_TEST_PROJECT`: Compose nombra las imágenes por
proyecto. Un proyecto nuevo necesita build.

El runner ejecuta tres modos y cuatro escenarios secuenciales:

1. `SAGA_STEPS=stock`.
2. `SAGA_STEPS=stock,dispatch`.
3. `SAGA_STEPS=stock,payment,dispatch` (full).
4. Full con `DISPATCH_FAIL_CREATE=true`.

Al terminar restaura `DISPATCH_FAIL_CREATE=false` y el `SAGA_STEPS` inicial, o full si no había un
valor propio, y verifica ambos. Deja el proyecto, la red y los volúmenes en marcha; no ejecuta
`down`, no borra volúmenes ni elimina clientes u órdenes de prueba. El padre decide cuándo detenerlo.

Guardas del runner:

- `P4_TEST_PROJECT` debe empezar por `repuestossur-p4-`; rechaza el proyecto normal, `default` y
  nombres sin el prefijo.
- `P4_TEST_PORT` debe ser un puerto TCP válido; `P4_GATEWAY_PUBLISHED_PORT` se deriva y debe
  coincidir si se exporta.
- `GATEWAY_BASE_URL` sólo se acepta en loopback y debe coincidir con el puerto del stack.
- Limpia `COMPOSE_FILE` y `COMPOSE_PROFILES`: sólo usa los dos `-f` previstos y ningún perfil
  implícito. Con `.env.p4` fija `COMPOSE_ENV_FILES`; sin él usa `COMPOSE_DISABLE_ENV_FILE=1`.
- El preflight exige los 11 servicios, labels y archivos Compose; falla si el puerto está ocupado.
- Exige el simulador en `normal`; los `SAGA_STEPS` de cada escenario se fijan y se restauran al
  final. El runner de continuidad exige además full ya en marcha y flags normales de Pagos.

El runner no usa fixture sintética de Despacho. Pagos es el servicio P2 real; la pasarela es
simulada. No hay cobro real.

## Smoke manual

```bash
GATEWAY_BASE_URL=http://127.0.0.1:8082 \
COMPOSE_PROJECT_NAME=repuestossur-p4-final \
COMPOSE_ENV_FILES=.env.p4 \
P4_SMOKE_EXPECT_STEPS=stock,payment,dispatch \
node tests/t2/p4-smoke.mjs
```

`GATEWAY_BASE_URL` debe ser loopback y coincidir con el stack. Para los `docker compose exec`
internos, `COMPOSE_PROJECT_NAME` y `COMPOSE_ENV_FILES` deben apuntar al mismo proyecto y archivo. Si
exportaste los secretos, puedes omitir `COMPOSE_ENV_FILES=.env.p4`.

El smoke detecta el `SAGA_STEPS` real dentro de Sales antes de mutar. Acepta `stock`,
`stock,dispatch` y `stock,payment,dispatch`; `full` es alias del último. `P4_SMOKE_EXPECT_STEPS` se
valida contra el valor real. Un subconjunto no soportado, como `stock,payment`, se rechaza.

- `stock`: resumen `404 SUMMARY_NOT_FOUND` con Pagos y Despacho `not_found`.
- `stock,dispatch`: resumen `200 partial:true`, Pagos `not_found` y Despacho `CREATED`; tras cancelar,
  Despacho `CANCELLED`.
- `stock,payment,dispatch`: resumen `200 partial:false`, Pagos `CHARGED` y Despacho `CREATED` con la
  misma orden/items; tras doble cancelación, Pagos `REFUNDED` y Despacho `CANCELLED`.
- La proyección del resumen es estricta: no expone `amountMinor`, `currency` ni campos internos.
- Replay `201` conserva el mismo cuerpo; el mismo key con payload distinto da `409`.

Si no recibe tokens, el smoke los obtiene con el CLI del Gateway y no los imprime. Cancela sus
órdenes en `finally`; el cliente y las órdenes canceladas persisten. También comprueba el rate limit;
esta guía no fija cuotas ni `Retry-After`.

Fixture opcional de Despacho, sólo para un proyecto arrancado con `SAGA_STEPS=stock`, aislada y sin
valor de Saga. No la ejecutes contra el stack full de la demo ni cambies el stack actual para
probarla:

```bash
GATEWAY_BASE_URL=http://127.0.0.1:8082 \
COMPOSE_PROJECT_NAME=repuestossur-p4-final \
COMPOSE_ENV_FILES=.env.p4 \
P4_SMOKE_EXPECT_STEPS=stock \
P4_SMOKE_DISPATCH_FIXTURE=true \
node tests/t2/p4-smoke.mjs
```

Comprueba `200 partial:true` con Pagos `not_found` y Despacho `CREATED`, y lo cancela. Si
`DISPATCH_FAIL_CREATE=true` está activo, se omite.

## Continuidad E3

El runner de continuidad usa el mismo proyecto y puerto, exige full real, flags normales de Pagos y
simulador en `normal`, y debe ejecutarse en exclusiva: no lo lances junto al smoke ni a otra carga.

```bash
P4_TEST_PROJECT=repuestossur-p4-final \
P4_TEST_PORT=8082 \
node tests/t2/p4-continuity.mjs
```

`node tests/t2/p4-continuity.mjs --help` documenta los argumentos exactos y el comando de
recreación de `payments-api`. Ejecuta cuatro brazos con tres repeticiones: Bulkhead protegido/sin
protección con simulador `slow` (650 ms, cap experimental 2) y Circuit Breaker protegido/sin
protección con simulador `down` y 8 órdenes secuenciales. Recrea sólo `payments-api` antes de cada
repetición para limpiar contadores y fijar flags/timeout; no reinicia el simulador. Restaura
configuración, cancela las ventas y verifica stock y flags. El informe JSON incluye contadores,
estados, `n` y percentiles; no incluye IDs, tokens ni logs crudos, y no es un SLO ni una prueba de
capacidad.

Resumen de la corrida real: 84 POST de negocio y 54 GET de clientes por Gateway, 0 rate limit;
Bulkhead protegido `6×201/12×503`, pico 2 y 4 rechazos por repetición; sin protección `18×201`, 0
rechazos. Circuit Breaker protegido y sin protección `24×503`; con protección el simulador recibió
3/8 por repetición y el circuito abrió una vez; sin protección 8/8 y 0 aperturas. Detalle y
percentiles en [VERIFICATION.md](VERIFICATION.md), §10. No se presentan como benchmark de Pagos.

## Overlay manual y demo

El Compose raíz sigue con `SAGA_STEPS=stock` por defecto. No lo cambies para la reproducción normal.
Para una demo coordinada, activa full explícitamente al levantar el overlay:

```bash
COMPOSE_PROJECT_NAME=repuestossur-p4-final \
COMPOSE_ENV_FILES=.env.p4 \
P4_GATEWAY_PUBLISHED_PORT=8082 \
SAGA_STEPS=stock,payment,dispatch \
docker compose -f docker-compose.yml -f docker-compose.p4.yml up --build -d --wait
```

El resultado esperado es Gateway en `http://127.0.0.1:8082`, BFF interno y 11 servicios. Pagos es el
servicio real de P2; `payment-gateway-sim` es la pasarela externa simulada oficial. No hay Pagos
mock en runtime ni dinero real.

Para detener, usa las mismas flags y prefiere `stop`:

```bash
COMPOSE_PROJECT_NAME=repuestossur-p4-final \
COMPOSE_ENV_FILES=.env.p4 \
P4_GATEWAY_PUBLISHED_PORT=8082 \
docker compose -f docker-compose.yml -f docker-compose.p4.yml stop
```

No uses `down -v`. Si necesitas retirar contenedores, `down` sin `-v` conserva volúmenes. El runner
no detiene el proyecto.

El guion de demo está en [DEMO-P4.md](DEMO-P4.md). No se grabó vídeo nuevo; el video preexistente no
se modificó.

## Pruebas por servicio y offline

```bash
cd apps/api-gateway
npm ci
npm run typecheck
npm test
npm run build

cd ../web-bff
npm ci
npm run typecheck
npm test
npm run build
```

La suite de agregación Gateway/BFF no usa Docker ni Pagos reales, pero requiere los builds:

```bash
cd apps/api-gateway && npm run build
cd ../web-bff && npm run build
cd ../..
node --test tests/t2/p4-aggregation.test.mjs
```

Las fuentes son dobles locales; no son Pagos ni Despacho reales y no se presentan como integración
P2.

Pruebas nativas:

```bash
node --test tests/t2/p4-smoke.test.mjs \
           tests/t2/p4-independent.test.mjs \
           tests/t2/p4-aggregation.test.mjs \
           tests/t2/p4-continuity.test.mjs
```

La referencia real del cierre está en [VERIFICATION.md](VERIFICATION.md), §10: Gateway 109 pruebas
en 7 archivos, BFF 102 en 6, 76 nativas (29 + 29 + 6 + 12) y 287 en total. `typecheck` y `build`
pasaron en ambos.

## CLI de tokens

```bash
READER_TOKEN="$(COMPOSE_PROJECT_NAME=repuestossur-p4-final \
  COMPOSE_ENV_FILES=.env.p4 \
  docker compose -f docker-compose.yml -f docker-compose.p4.yml exec -T api-gateway \
  node dist/src/cli/token.js --sub p4-reader --role reader)"
```

El TTL por defecto es de 15 minutos. No hay login, refresh ni base de identidad.

## Límites

- Pagos es real de P2, pero la pasarela es simulada; no hay dinero real.
- La pasarela guarda estado en memoria; al reiniciarla olvida sus cobros.
- La integración final en el Compose raíz y la CI del grupo no están aprobadas aquí.
- La corrida E3 es pequeña y de mecanismo; no es SLO, capacidad ni benchmark.
- El rate limit del Gateway es en memoria y monoinstancia.
- JWT de demo, sin proveedor de identidad ni revocación.
- No se ejecutó CI. No se hizo una auditoría npm nueva; la alerta histórica de
  [VERIFICATION.md](VERIFICATION.md), §6, se conserva.
- [P2-PAGOS.md](P2-PAGOS.md) y [P3-SAGA.md](P3-SAGA.md) conservan su fecha y pueden describir hitos
  anteriores; no se editaron en esta entrega.
- La grabación de la demo es responsabilidad común si se decide publicar video.

## Documentos relacionados

- [Verificación P4](VERIFICATION.md)
- [Especificación P4](P4-SPEC.md)
- [Plan de experimento](EXPERIMENT-PLAN.md)
- [Guion de demo](DEMO-P4.md)
- [Contratos internos T2](../architecture/T2-INTERNAL-CONTRACTS.md)
