# P4: Gateway y BFF — reproducción local

Esta guía reproduce la exposición P4 sobre el estado actual del repositorio. El Compose raíz ya no
es sólo la línea base T1: incluye Sales, Inventory, Dispatch y la Saga P3 en modo stock
(`SAGA_STEPS=stock`). P3 está implementada en Sales, pero Pagos P2 no existe todavía; el flujo de
cobro y la Saga completa no están cerrados. El overlay P4 agrega Gateway y BFF. La integración final
en un único `docker compose up --build` sigue pendiente.

La evidencia real de la corrida actual está en [VERIFICATION.md](VERIFICATION.md), §9. El runner no
es una demo completa: no hay Pagos reales, cobro, reembolso ni Saga de tres pasos.

## Requisitos

- Node.js 24 LTS. La corrida registrada usó `24.21.0`.
- Docker Engine con Docker Compose. La corrida registrada usó Compose `5.6.0`. El overlay usa
  `!reset`; la documentación upstream lo sitúa desde Compose 2.24.0, pero la versión mínima no se
  verificó aquí.
- Linux para la corrida registrada.
- Secretos disponibles en variables de entorno o en un `.env.p4` local ignorado por Git, con modo
  `0600`. No se versiona ni se imprime ningún valor.

El runner aislado publica el Gateway en `127.0.0.1:8081` por defecto. El overlay manual conserva
`8080` como puerto común si no se define `P4_GATEWAY_PUBLISHED_PORT`. BFF, Sales, Inventory,
Dispatch y las bases no publican puertos host en el overlay.

## Configuración local

El Gateway exige `GATEWAY_JWT_SECRET` de al menos 32 bytes. Genera el secreto en la terminal:

```bash
export GATEWAY_JWT_SECRET="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
```

Sales y el Gateway comparten las claves internas. Exporta dos valores distintos:

```bash
export API_KEY_READER="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
export API_KEY_OPERATOR="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
```

No exportes `GATEWAY_SALES_API_KEY_READER` ni `GATEWAY_SALES_API_KEY_OPERATOR` para el overlay: el
Compose inyecta en el Gateway los valores de `API_KEY_READER` y `API_KEY_OPERATOR`. No publiques
tokens, claves ni secretos en logs, capturas o documentos.

Si usas un archivo local, debe quedar ignorado por Git y con permisos restrictivos:

```bash
chmod 600 .env.p4
```

El runner acepta `.env.p4` sólo como entrada y sólo si es un archivo regular sin permisos de grupo u
otros (`0600` recomendado). No lo crea, no lo copia y no imprime sus valores. Sin `.env.p4`, usa los
secretos exportados y desactiva el `.env` genérico para no cargar perfiles o archivos no solicitados.

## Runner aislado

Desde la raíz del repositorio, con proyecto y puerto explícitos:

```bash
P4_TEST_PROJECT=repuestossur-p4-independent \
P4_TEST_PORT=8081 \
node tests/t2/p4-independent.mjs --no-build
```

Sin `--no-build`, el runner construye las imágenes antes de arrancar. `--no-build` sólo reutiliza
imágenes ya construidas para **el mismo** `P4_TEST_PROJECT`: Compose nombra las imágenes por
proyecto, así que un proyecto nuevo necesita build. El runner no instala dependencias en el host ni
elimina imágenes.

Guardas del runner:

- `P4_TEST_PROJECT` debe empezar por `repuestossur-p4-`; el valor por defecto es
  `repuestossur-p4-independent`. Rechaza el proyecto normal del repositorio, `default` y nombres sin
  el prefijo.
- `P4_TEST_PORT` debe ser un puerto TCP válido; el valor por defecto es `8081`.
  `P4_GATEWAY_PUBLISHED_PORT` se deriva de ese puerto y debe coincidir si se exporta.
- `GATEWAY_BASE_URL` sólo se acepta si es loopback y coincide exactamente con el puerto del stack.
  No se envían credenciales a una URL remota o arbitraria.
- El entorno de Compose limpia `COMPOSE_FILE` y `COMPOSE_PROFILES`. Los comandos usan sólo los dos
  `-f` previstos y ningún perfil implícito. Con `.env.p4` explícito se fija `COMPOSE_ENV_FILES`; sin
  él se usa `COMPOSE_DISABLE_ENV_FILE=1` y sólo cuentan los secretos exportados.
- El preflight exige los ocho servicios del overlay, comprueba labels y archivos Compose y falla si
  el puerto está ocupado por otro proceso. No mata procesos ni usa contenedores del proyecto normal.

El runner ejecuta tres escenarios secuenciales:

1. `SAGA_STEPS=stock` y `DISPATCH_FAIL_CREATE=false`.
2. `SAGA_STEPS=stock,dispatch` y `DISPATCH_FAIL_CREATE=false`.
3. `SAGA_STEPS=stock,dispatch` y `DISPATCH_FAIL_CREATE=true`.

Al terminar restaura `DISPATCH_FAIL_CREATE=false` y el `SAGA_STEPS` inicial, o `stock,dispatch` si
no había un valor propio, y verifica ambos valores en los contenedores. Deja el proyecto, la red y
los volúmenes en marcha; no ejecuta `down`, no borra volúmenes y no elimina clientes ni órdenes de
prueba. El padre decide cuándo detenerlo. Si la restauración falla, el runner termina distinto de
cero.

El runner no usa la fixture sintética de Despacho en ninguno de los modos. No demuestra Pagos,
CB/BH, reembolso ni la Saga completa; la compensación observada es la de stock en el fallo de
Despacho, sin cobro.

## Smoke manual

El smoke se ejecuta desde la raíz y no tiene dependencias de npm:

```bash
node tests/t2/p4-smoke.mjs
```

Por defecto usa `GATEWAY_BASE_URL=http://127.0.0.1:8080`. Si usas el runner, pasa el puerto real:

```bash
GATEWAY_BASE_URL=http://127.0.0.1:8081 \
COMPOSE_PROJECT_NAME=repuestossur-p4-independent \
COMPOSE_ENV_FILES=.env.p4 \
P4_SMOKE_EXPECT_STEPS=stock,dispatch \
node tests/t2/p4-smoke.mjs
```

`GATEWAY_BASE_URL` debe ser loopback y coincidir con el stack que se está probando. Si usas
`docker compose exec` internos, `COMPOSE_PROJECT_NAME` y `COMPOSE_ENV_FILES` deben apuntar al mismo
proyecto y archivo que levantó el stack. Si exportaste los secretos en la terminal, puedes omitir
`COMPOSE_ENV_FILES=.env.p4`.

El smoke comprueba health de Gateway/Sales, autenticación, roles, cliente, orden idempotente,
conflicto de payload y cancelación, además del modo de Saga. También comprueba el rate limit del
Gateway; esta guía no fija números de cuota ni `Retry-After` observados.

El smoke detecta el `SAGA_STEPS` real dentro del contenedor de Sales antes de mutar. Acepta sólo
`stock` y `stock,dispatch`. `P4_SMOKE_EXPECT_STEPS` es opcional y, si se indica, se valida contra el
valor real; un modo con `payment` o `full` falla con «pendiente de integración P2» y no simula éxito.

- En `stock`, conserva las aserciones del resumen sin Pagos/Despacho. El contrato admite `503` o
  `404`; el smoke no fija un estado observado en esta guía.
- En `stock,dispatch`, crea la venta por Gateway, comprueba creación `201`, replay `201` con el mismo
  cuerpo y conflicto `409`; exige resumen `200 partial:true` con Pagos `unavailable` y Despacho
  `available CREATED` con el mismo `orderId`/items; después cancela dos veces y verifica Sales y
  Despacho en `CANCELLED`.

Si no recibe `GATEWAY_READER_TOKEN` y `GATEWAY_OPERATOR_TOKEN`, obtiene tokens con el CLI del
contenedor del Gateway. Los tokens no se imprimen. El smoke cancela sus órdenes en `finally`; si una
cancelación no confirma `200 CANCELLED`, deja un aviso con el UUID y termina distinto de cero. El
cliente demo y las órdenes canceladas persisten: Sales no expone borrado y el smoke no elimina
tablas, bases ni volúmenes.

Fixture opcional de Despacho, sólo para `stock`, aislada y sin valor de Saga:

```bash
COMPOSE_PROJECT_NAME=repuestossur-p4-independent \
COMPOSE_ENV_FILES=.env.p4 \
P4_SMOKE_DISPATCH_FIXTURE=true \
node tests/t2/p4-smoke.mjs
```

Crea un despacho sintético con un UUID distinto, comprueba `200 partial:true` con Pagos
`unavailable` y Despacho `available CREATED`, y lo cancela. No atribuye el resumen a una orden de
Sales. Si `DISPATCH_FAIL_CREATE=true` está activo, omite la fixture con un motivo explícito. No es
evidencia de Saga.

## Overlay manual

Para levantar el overlay con el puerto aislado y las mismas variables:

```bash
COMPOSE_PROJECT_NAME=repuestossur-p4-independent \
COMPOSE_ENV_FILES=.env.p4 \
P4_GATEWAY_PUBLISHED_PORT=8081 \
docker compose -f docker-compose.yml -f docker-compose.p4.yml up --build -d --wait
```

El resultado esperado es Gateway en `http://127.0.0.1:8081`, BFF en la red interna, y Sales,
Inventory, Dispatch y sus bases sin puerto host. Toxiproxy y `sales-test-db` tampoco publican puertos
host en el overlay. Pagos no es un servicio: la fuente del BFF queda `unavailable` mientras no exista
`payments-api`.

Para probar manualmente los modos de Saga, exporta `SAGA_STEPS=stock` o
`SAGA_STEPS=stock,dispatch` al levantar o recrear los servicios. No edites el Compose raíz ni actives
`stock,payment,dispatch`: Pagos P2 no existe.

Para detener, usa las mismas flags y prefiere `stop` explícito:

```bash
COMPOSE_PROJECT_NAME=repuestossur-p4-independent \
COMPOSE_ENV_FILES=.env.p4 \
P4_GATEWAY_PUBLISHED_PORT=8081 \
docker compose -f docker-compose.yml -f docker-compose.p4.yml stop
```

No uses `down -v`. Si necesitas retirar contenedores, `down` sin `-v` conserva los volúmenes; para
la reproducción normal se prefiere `stop`. El runner no detiene el proyecto por ti.

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

La suite black-box de agregación Gateway/BFF no usa Docker ni Pagos reales, pero requiere los builds
de ambos servicios:

```bash
cd apps/api-gateway && npm run build
cd ../web-bff && npm run build
cd ../..
node --test tests/t2/p4-aggregation.test.mjs
```

Las fuentes de esa prueba son dobles locales; no son Pagos ni Despacho reales. No se presentan como
evidencia de integración P2.

Pruebas nativas del smoke y del runner, desde la raíz:

```bash
node --test tests/t2/p4-smoke.test.mjs \
           tests/t2/p4-independent.test.mjs \
           tests/t2/p4-aggregation.test.mjs
```

La referencia real del cierre actual está en [VERIFICATION.md](VERIFICATION.md), §9: Gateway 109
pruebas en 7 archivos, BFF 102 en 6, y 59 pruebas nativas; `typecheck` y `build` pasaron en ambos,
para 270 pruebas en total.

## CLI de tokens

Para obtener un token sin imprimirlo, usa el mismo proyecto y archivo de entorno que el stack. El
ejemplo asume el proyecto del runner:

```bash
READER_TOKEN="$(COMPOSE_PROJECT_NAME=repuestossur-p4-independent \
  COMPOSE_ENV_FILES=.env.p4 \
  docker compose -f docker-compose.yml -f docker-compose.p4.yml exec -T api-gateway \
  node dist/src/cli/token.js --sub p4-reader --role reader)"
```

También se puede usar el script local, con el secreto exportado:

```bash
cd apps/api-gateway
npm run --silent token -- --sub p4-reader --role reader
```

El TTL por defecto es de 15 minutos. No hay login, refresh ni base de datos de identidad.

## Límites conocidos

- Pagos P2 no existe; no hay cobro, reembolso, Circuit Breaker ni Bulkhead reales.
- P3 está implementada en Sales, pero la Saga completa con Pagos no está verificada.
- El JWT es de demo; no hay proveedor de identidad ni revocación.
- El rate limit del Gateway es en memoria y monoinstancia.
- No hay TLS, CORS ni frontend en este alcance.
- La integración final en un único Compose raíz no está hecha.
- No se ejecutó CI. No se hizo una auditoría npm nueva; la alerta histórica de `npm audit` se
  conserva en [VERIFICATION.md](VERIFICATION.md), §6, y no se presenta como resuelta.

## Documentos relacionados

- [Verificación P4](VERIFICATION.md)
- [Especificación P4](P4-SPEC.md)
- [Plan de experimento](EXPERIMENT-PLAN.md)
- [Contratos internos T2](../architecture/T2-INTERNAL-CONTRACTS.md)
