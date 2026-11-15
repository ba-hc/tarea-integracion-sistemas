# P4: Gateway y BFF — reproducción local

Esta guía describe la implementación opt-in de P4, validada de forma aislada. El Compose raíz
sigue siendo la línea base T1; la integración final en un único `docker compose up --build` queda
pendiente de coordinar P2/P3. El smoke y los Dockerfiles no demuestran la Saga ni una integración
real con Pagos. Los resultados del cierre están en [VERIFICATION.md](VERIFICATION.md).

## Requisitos

- Node.js 24 LTS.
- Docker Engine con Docker Compose. El overlay usa `!reset` para retirar puertos heredados.
  Se validó con Compose v5.6.0. La documentación upstream sitúa `!reset` desde Compose 2.24.0;
  la versión mínima no se verificó en este entorno.
- Puertos libres: `127.0.0.1:8080` para el Gateway. BFF, Sales, Inventory y Dispatch no publican
  puertos host en el overlay.

## Secreto JWT local

El Gateway exige `GATEWAY_JWT_SECRET` de al menos 32 bytes. Genéralo en la terminal y no lo
guardes en el repositorio:

```bash
export GATEWAY_JWT_SECRET="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
```

No uses un valor fijo en archivos versionados. Si eliges un archivo local, debe quedar ignorado
por Git, con permisos restrictivos, y pasarse explícitamente con `--env-file`; la opción
recomendada es exportarlo sólo en la terminal. No publiques tokens, claves ni secretos en capturas
o logs.

Por ejemplo, si usas un `.env.p4` local no versionado:

```bash
chmod 600 .env.p4
docker compose --env-file .env.p4 -f docker-compose.yml -f docker-compose.p4.yml config --quiet
```

## Levantar el overlay

Desde la raíz del repositorio:

```bash
docker compose -f docker-compose.yml -f docker-compose.p4.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.p4.yml up --build -d --wait
```

El resultado esperado es:

- Gateway en `http://127.0.0.1:8080`.
- BFF en la red interna, puerto 3002, sin puerto host.
- Sales, Inventory y Dispatch internos. Toxiproxy y `sales-test-db` tampoco publican puertos host
  cuando se activan sus perfiles.
- Sin servicio de Pagos: `BFF_PAYMENTS_BASE_URL` apunta por defecto a
  `http://payments-api:3003`, una dirección provisional configurable. La fuente queda
  `unavailable` mientras Pagos no exista; no hay mock de Pagos en runtime.

El overlay **no lee** `GATEWAY_SALES_API_KEY_READER` ni `GATEWAY_SALES_API_KEY_OPERATOR` desde
tu terminal. Compose inyecta en el Gateway los valores de `API_KEY_READER` y `API_KEY_OPERATOR`,
las mismas variables que el Compose raíz usa para Sales. Exporta exactamente estas dos, con
valores distintos:

```bash
export API_KEY_READER="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
export API_KEY_OPERATOR="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
```

No exportes `GATEWAY_SALES_API_KEY_*` para el overlay: no se pasan al contenedor. El archivo
`apps/api-gateway/.env.example` sirve para ejecutar el servicio local sin Docker; no es la
configuración del overlay.

Para detener el overlay sin borrar volúmenes:

```bash
docker compose -f docker-compose.yml -f docker-compose.p4.yml down
```

No uses `down -v` para este entorno. El `docker-compose.yml` raíz no se modifica.

## Pruebas por servicio

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

Como referencia real del cierre, consulta [VERIFICATION.md](VERIFICATION.md). Para las pruebas
unitarias nativas del smoke, desde la raíz:

```bash
node --test tests/t2/p4-smoke.test.mjs
```

## Smoke de sistema

El smoke se ejecuta desde la raíz y no tiene dependencias de npm:

```bash
node tests/t2/p4-smoke.mjs
```

Por defecto usa `GATEWAY_BASE_URL=http://127.0.0.1:8080`. Si no recibe
`GATEWAY_READER_TOKEN` y `GATEWAY_OPERATOR_TOKEN`, obtiene tokens con el CLI incluido en la
imagen del Gateway mediante `docker compose exec`. Los tokens no se imprimen.

Si usas un `.env.p4` local en lugar de exportar el secreto, prefija el smoke con
`COMPOSE_ENV_FILES=.env.p4` para que los `docker compose exec` internos resuelvan
`GATEWAY_JWT_SECRET`. La variante con el secreto exportado en la terminal sigue siendo válida.

El smoke comprueba salud propia y de Sales, autenticación, roles, cliente y orden idempotente,
conflicto de payload, cancelación repetida, resumen sin Pagos/Despacho y el contador de rate
limit. Lee el límite y la ventana del contenedor y omite el escenario de cuota con un motivo
explícito si la ventana es demasiado corta o el límite supera 1000. Si la ventana cambia durante
la medición, reintenta una vez con una identidad nueva y no acepta una respuesta 200 sin el 429;
el máximo son dos rondas. Cancela sus órdenes en `finally`; no borra tablas ni volúmenes. Si una
cancelación no confirma HTTP 200 con `CANCELLED`, deja un aviso con el UUID para recuperación y
el smoke termina con código distinto de cero. El cliente demo y las órdenes canceladas quedan como
registros de prueba: Sales no expone un endpoint de borrado y el smoke no elimina tablas ni
volúmenes.

Fixture opcional de Despacho, aislada y sin valor de Saga:

```bash
COMPOSE_ENV_FILES=.env.p4 P4_SMOKE_DISPATCH_FIXTURE=true node tests/t2/p4-smoke.mjs
```

Si exportaste `GATEWAY_JWT_SECRET` en la terminal, puedes omitir `COMPOSE_ENV_FILES=.env.p4`.

Crea un despacho sintético con un UUID distinto, comprueba el resumen `200 partial:true` con
Pagos `unavailable` y Despacho `available`, y lo cancela al terminar. No atribuye el resumen a la
existencia de una orden en Sales. Si `DISPATCH_FAIL_CREATE=true` ya está activo, el smoke omite
la fixture con un motivo explícito.

## CLI de tokens

Para obtener un token sin imprimirlo:

```bash
READER_TOKEN="$(docker compose -f docker-compose.yml -f docker-compose.p4.yml exec -T api-gateway \
  node dist/src/cli/token.js --sub p4-reader --role reader)"
```

También se puede usar el script local, con el secreto exportado:

```bash
cd apps/api-gateway
npm run --silent token -- --sub p4-reader --role reader
```

El TTL por defecto es de 15 minutos. No hay login, refresh ni base de datos de identidad.

## Límites conocidos

- El JWT es de demo; no hay proveedor de identidad ni revocación.
- El rate limit del Gateway es en memoria y monoinstancia.
- Pagos sigue siendo una propuesta P2 y la Saga/compensación pertenece a P3.
- Los presupuestos de timeout y la recuperación de la Saga se acuerdan en P3.
- No hay TLS, CORS ni frontend en este alcance.
- `npm audit` reporta 4 vulnerabilidades por servicio (2 high, 2 moderate), sin `npm audit fix`
  ni upgrades en este cierre.
- La integración final en un único Compose raíz no está hecha.

## Documentos relacionados

- [Verificación P4](VERIFICATION.md)
- [Especificación P4](P4-SPEC.md)
- [Plan de experimento](EXPERIMENT-PLAN.md)
- [Contratos internos T2](../architecture/T2-INTERNAL-CONTRACTS.md)
