# Verificación P4 — Gateway y BFF

**Estado actual (2026-11-22):** Gateway, BFF y los modos `stock`/`stock,dispatch` verificados con
una corrida real del runner. Pagos P2 sigue ausente; no hay cobro, reembolso, Circuit Breaker ni
Bulkhead reales, y la Saga completa no está cerrada. La evidencia vigente está en §9.

**Leyenda histórica:** Las secciones 1–8 documentan el hito `7daf5d0` y conservan sus números y
resultados. No describen el estado actual. Las menciones a P3/Saga como pendientes en ese hito son
históricas: P3 está implementada en Sales, pero Pagos P2 no existe. Este documento no certifica
seguridad de producción ni una regresión completa de CI.

## 1. Línea base

| Elemento | Registro |
|---|---|
| Rama | `main` |
| Commit base | `7daf5d0` (T1 + Despacho) |
| Estado al verificar | Cambios P4 locales, antes del commit de entrega |
| Node.js | `24.21.0` |
| Docker Compose | `5.6.0` |
| Secreto local | `.env.p4` ignorado por Git, modo `0600`, generado; valor no incluido aquí |

## 2. T1 y Despacho sobre el Compose raíz

| Comprobación | Resultado |
|---|---|
| `docker compose config --quiet` | OK |
| `docker compose up --build -d --wait` original T1 + Despacho | OK; seis contenedores |
| Sales `GET /v1/health` sin key | `200` |
| `GET /v1/customers` sin key | `401` |
| `reader` en `GET /v1/customers` | `200` |
| `reader` en `POST /v1/customers` | `403` |
| `apps/dispatch-api/test/dispatch.integration.mjs` | 4 pruebas pasaron |

## 3. Pruebas automatizadas P4

| Suite | Archivos | Resultado |
|---|---:|---|
| Gateway | 7 | 100 pasaron |
| BFF | 6 | 102 pasaron |
| Unitarias nativas del smoke (`node --test`) | 1 | 19 pasaron |
| **Total nuevo P4** | | **221 pruebas** |

`npm run typecheck` y `npm run build` pasaron en Gateway y BFF. No hay ESLint configurado; no se
ejecutó lint y no se presenta `tsc` como lint.

## 4. Overlay y runtime

| Comprobación | Resultado |
|---|---|
| Config del overlay con `.env.p4` | OK; también ejecutado con el mismo efecto mediante entorno inyectado |
| Effective config con perfiles `experiment` y `test` | Sólo `127.0.0.1:8080` del Gateway |
| BFF | Interno, `expose: 3002`, sin puerto host |
| Sales, Inventory, Dispatch y sus bases | Internos, sin puerto host |
| Servicio Pagos / Saga | No existen en el overlay |
| Contenedores del overlay | 8, healthy |
| Volúmenes | Sin cambios; no se ejecutó `down` ni borrado de volúmenes |

El Compose raíz no se modificó y su validación de arranque T1/Despacho siguió pasando.

## 5. Smoke real con fixture

Comando reproducido dos veces: la segunda desde shell exacta y la primera con el mismo entorno
inyectado. Ambas terminaron PASS.

```bash
COMPOSE_ENV_FILES=.env.p4 P4_SMOKE_DISPATCH_FIXTURE=true node tests/t2/p4-smoke.mjs
```

| Escenario | Resultado |
|---|---|
| Health Gateway y Sales | `200` |
| Sin token | `401` con `WWW-Authenticate: Bearer` |
| `reader` GET / POST | `200` / `403` |
| Cliente con `operator` | `201` |
| Crear orden | `201 CONFIRMED` |
| Replay misma key y payload | `201`, mismo cuerpo, `Idempotency-Replayed: true` |
| Misma key, payload distinto | `409 IDEMPOTENCY_KEY_CONFLICT` |
| Cancelar dos veces | `200 CANCELLED` |
| Resumen de orden existente sin fuentes | `503 UPSTREAM_UNAVAILABLE` del BFF con `details.sources`; sin `CHARGED` falso |
| Rate limit | 60 permitidas + 1 rechazo `429`; una ventana y una ronda |
| Fixture de Despacho aislada | `PUT` interno creado; resumen `200 partial:true`, payment `unavailable`, dispatch `available CREATED`; sin `CHARGED` |

`Retry-After` observado: 16 s y 43 s en las dos ejecuciones; es dato opcional y no se usa como
criterio de estabilidad. Todas las órdenes y el despacho creados quedaron confirmados como
`CANCELLED`. El cliente demo y las órdenes canceladas persisten; el stock se repuso. No se
borraron tablas ni volúmenes.

## 6. Contratos, CI y deuda

| Elemento | Estado |
|---|---|
| Contratos congelados | Sin diff |
| Apps Sales, Inventory y Dispatch | Sin diff |
| `docker-compose.yml`, CI y README raíz | Sin diff |
| `git diff --check` | OK |
| CI de GitHub | No ejecutado en este cierre |
| Regresión completa de DB y fallas | No ejecutada |
| `npm audit` Gateway | Exit 1; 4 alertas: 2 high prod, 2 moderate dev, 0 critical |
| `npm audit` BFF | Exit 1; 4 alertas: 2 high prod, 2 moderate dev, 0 critical |
| Correcciones de auditoría | No se aplicaron fixes ni upgrades |

Las alertas high de producción son `@nestjs/platform-express`/`multer`; las moderate de desarrollo
son `vitest`/`@vitest/mocker`. El runtime P4 no expone carga de archivos, pero eso no elimina la
deuda de auditoría. No se afirma que las vulnerabilidades estén resueltas.

## 7. Límites y pendientes

Estado del hito histórico; ver §9 para el estado actual.

- JWT de demo, sin proveedor de identidad ni revocación.
- Rate limit en memoria y monoinstancia.
- Pagos sigue siendo una propuesta P2; no hay integración real.
- Saga, compensaciones y presupuesto de recuperación pertenecen a P3.
- La integración final en un único Compose raíz sigue pendiente.
- No hay evidencia de Saga, fallas P2/P3 ni certificación de seguridad de producción.
- No se ejecutaron experimentos de falla ni la CI completa.

## 8. Reproducción

Comandos del hito histórico; la reproducción actual está en §9.

```bash
# Pruebas por servicio
cd apps/api-gateway && npm ci && npm run typecheck && npm test && npm run build
cd ../web-bff && npm ci && npm run typecheck && npm test && npm run build
cd ../..

# Unitarias nativas del smoke, desde la raíz
node --test tests/t2/p4-smoke.test.mjs

# Overlay y smoke, desde la raíz; .env.p4 local, ignorado y con permisos 0600
docker compose --env-file .env.p4 -f docker-compose.yml -f docker-compose.p4.yml config --quiet
docker compose --env-file .env.p4 -f docker-compose.yml -f docker-compose.p4.yml up --build -d --wait
COMPOSE_ENV_FILES=.env.p4 P4_SMOKE_DISPATCH_FIXTURE=true node tests/t2/p4-smoke.mjs
```

La variante de exportar `GATEWAY_JWT_SECRET` en la terminal sigue siendo válida; no se exige un
archivo. No se publican secretos, tokens, IDs de objetos ni cuerpos crudos en este documento.

## 9. Evidencia actual — 2026-11-22

### 9.1 Entorno y snapshot

- Linux.
- `main` en `338681d` + delta P4 sin commit.
- Node.js `24.21.0`; Docker Compose `5.6.0`.
- `.env.p4` ignorado por Git, modo `0600`.
- Cinco imágenes construidas: Sales, Inventory, Dispatch, Gateway y BFF.
- Proyecto aislado `repuestossur-p4-independent`; Gateway publicado sólo en
  `127.0.0.1:8081`.

### 9.2 Comando y resultado

Desde la raíz:

```bash
P4_TEST_PROJECT=repuestossur-p4-independent \
P4_TEST_PORT=8081 \
node tests/t2/p4-independent.mjs --no-build
```

Resultado: exit `0`; JSON final `status: passed`, `pagos: absent`. El runner no usó la fixture
sintética de Despacho en ninguno de los modos. El JSON se conservó localmente durante la
verificación; no es un requisito de reproducción ni se entrega como artefacto versionado.

### 9.3 Escenarios

| Escenario | Evidencia |
|---|---|
| `stock` | Smoke PASS. `GetPart` antes/después: `5 → 5`. Sin fixture sintética. |
| `stock,dispatch` | Smoke PASS. Creación `201`; replay `201` con el mismo cuerpo; conflicto `409`. Resumen `200 partial:true`, Pagos `unavailable`, Despacho `available CREATED`, mismo `orderId`/items. Cancelación repetida: Sales y Despacho `CANCELLED`. `GetPart`: `5 → 5`. Sin fixture sintética. |
| `DISPATCH_FAIL_CREATE=true` sin Pagos | `503 DISPATCH_UNAVAILABLE`; replay con el mismo código y mensaje; traza comprobada. `GET /v1/orders?customerId=…` `200` con cero órdenes; `GET /v1/customers` `200` (una lectura, no carga). `GetPart` antes/tras primer 503/tras replay: `5 → 5 → 5`. |

El resumen del modo `stock` se valida contra el contrato, que admite `503` o `404`; esta corrida no
fija un estado observado en este documento. El `503` de §5 pertenece al hito histórico. `GetPart` se
leyó sólo antes y después; no se observó stock durante la reserva ni se usa como prueba de atomicidad
de P1.

Restauración observada:

```json
{"sagaSteps":"stock,dispatch","dispatchFailCreate":"false","verified":true}
```

Después de la corrida quedaron ocho contenedores healthy, sólo `127.0.0.1:8081` publicado, y la red
y los volúmenes aislados conservados. El cliente y las órdenes canceladas de prueba persisten. No se
ejecutó SQL, no se tocaron bases ajenas y no se borraron contenedores, redes ni volúmenes.

La compensación observada es la de stock en el fallo de Despacho, sin Pagos: no se probó cobro,
reembolso, Circuit Breaker, Bulkhead ni la Saga de tres pasos. No es una demostración completa ni una
prueba de atomicidad.

### 9.4 Pruebas automatizadas actuales

| Suite | Resultado |
|---|---|
| Gateway (`npm test`) | 109 pruebas / 7 archivos |
| BFF (`npm test`) | 102 pruebas / 6 archivos |
| Nativas (`node --test`) | 59/59: smoke 29 + independent 24 + aggregate 6 |
| **Total** | **270** |

`npm run typecheck` y `npm run build` pasaron en Gateway y BFF. `config --services` con variables de
entorno contaminadas quedó en 8 servicios, sin perfiles. La configuración CLI del overlay con
`test` y `experiment` se comprobó sólo para Gateway en `8081`; no se ejecutaron esos perfiles ni
servicios extra. No se ejecutó CI. No se hizo una auditoría npm nueva: la alerta histórica de §6 se
conserva y no se presenta como resuelta. No hay integración real con Pagos, Circuit Breaker ni
Bulkhead.

### 9.5 Trazabilidad

Un primer intento del CLI falló en el preflight por un timeout pasado como objeto, antes de tocar
contenedores. Se corrigió la firma, se añadió una regresión y la reauditoría posterior pasó. La
corrida reportada en §9.2 es la posterior a esa corrección.

La corrida actual no registra tasas, latencias, `Retry-After` ni resultados de E1–E3; no se
infieren ni se fabrican.
