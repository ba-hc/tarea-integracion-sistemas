# Verificación P4 — Gateway y BFF

**Estado actual (2026-11-23):** P4 cerrado en modo overlay local. Gateway y BFF se verificaron
contra Pagos P2 **real** y la pasarela de pagos **simulada oficial**, con la Saga full. La evidencia
vigente está en §10.

**Leyenda histórica:** Las secciones 1–9 conservan sus hitos y cifras. §1–8 documentan `7daf5d0`;
§9 documenta la corrida previa sin Pagos. Las menciones a Pagos ausente o a la Saga pendiente en
esas secciones son históricas. Este documento no certifica seguridad de producción, capacidad, SLO
ni una regresión completa de CI.

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

Estado del hito histórico; ver §10 para el estado actual.

- JWT de demo, sin proveedor de identidad ni revocación.
- Rate limit en memoria y monoinstancia.
- En este hito, Pagos seguía siendo una propuesta P2; no había integración real.
- Saga, compensaciones y presupuesto de recuperación pertenecen a P3.
- La integración final en un único Compose raíz sigue pendiente.
- No hay evidencia de Saga, fallas P2/P3 ni certificación de seguridad de producción.
- No se ejecutaron experimentos de falla ni la CI completa.

## 8. Reproducción

Comandos del hito histórico; la reproducción actual está en §10.

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

## 9. Evidencia previa — 2026-11-22

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

### 9.4 Pruebas automatizadas del hito

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

La corrida de este hito no registra tasas, latencias, `Retry-After` ni resultados de E1–E3; no se
infieren ni se fabrican.

## 10. Evidencia actual — 2026-11-23

### 10.1 Entorno y snapshot

- Fecha: 2026-11-23 (local/UTC).
- Linux x86_64, kernel `6.12.111+deb13-amd64`; 12 CPUs disponibles.
- Docker `29.9.0`; Docker Compose `5.6.0`; Node.js `24.21.0`.
- Base Git `0edd96a` + cambios P4 locales, sin commit.
- Proyecto `repuestossur-p4-final`, puerto loopback `8082`, 11 servicios healthy.
- Siete imágenes construidas para ese mismo proyecto: Sales, Inventory, Dispatch, Pagos, pasarela
  simulada, Gateway y BFF. Gateway y BFF no cambiaron su runtime en esta entrega; el trabajo es de
  verificación y documentación.
- Sólo `127.0.0.1:8082` publicado. Pagos, pasarela, BFF, Sales, Inventory, Dispatch y bases quedan
  internos; tampoco se publican puertos de administración ni de bases de prueba.
- `.env.p4` local, ignorado por Git y con permisos restrictivos; valores no incluidos.

### 10.2 Comandos y resultado

Desde la raíz, con las imágenes ya construidas para ese proyecto:

```bash
P4_TEST_PROJECT=repuestossur-p4-final \
P4_TEST_PORT=8082 \
node tests/t2/p4-independent.mjs --no-build
```

Resultado: exit `0`; JSON final `status: passed`, `pagos: real-service+simulated-gateway`.

```bash
P4_TEST_PROJECT=repuestossur-p4-final \
P4_TEST_PORT=8082 \
node tests/t2/p4-continuity.mjs
```

Resultado: exit `0`; JSON final `status: passed`. La continuidad se ejecutó en el mismo proyecto y
puerto, con simulador en `normal` y flags por defecto, de forma exclusiva y serial.

No se usó fixture sintética de Despacho en ninguno de los cuatro modos. El runner usa los servicios
reales del stack; en full, Pagos y Despacho son reales y la pasarela externa es la simulada oficial.
Las suites unitarias y de agregación usan dobles locales y no se presentan como integración real.

### 10.3 Escenarios

| Modo | Resultado |
|---|---|
| `stock` | Smoke PASS. Resumen `404 SUMMARY_NOT_FOUND` con Pagos y Despacho `not_found`. `GetPart` `5 → 5`. |
| `stock,dispatch` | Smoke PASS. Resumen `200 partial:true`, Pagos `not_found`, Despacho `CREATED`; tras cancelar, Despacho `CANCELLED`. `GetPart` `5 → 5`. |
| `stock,payment,dispatch` | Creación `201 CONFIRMED`; replay `201` con el mismo payload/cuerpo; misma key con payload distinto `409`. Resumen `200 partial:false` con Pagos `CHARGED` y Despacho `CREATED`, misma orden/items y sin extras de Pagos. Doble cancelación deja Pagos `REFUNDED` y Despacho `CANCELLED`. `GetPart` `5 → 5`. Deltas de la pasarela: `+1` cobros, `+1` reembolsos, `0` anulaciones. |
| Full con `DISPATCH_FAIL_CREATE=true` | `503 DISPATCH_UNAVAILABLE`; el replay con la misma `Idempotency-Key` devuelve el mismo código y mensaje. Cero órdenes públicas; `GET /v1/customers` `200`. `GetPart` antes/tras primer fallo/tras replay: `5 → 5 → 5`. Deltas del primer fallo: `1/1/0`; del replay: `0/0/0`. |

Restauración observada: `SAGA_STEPS=stock,payment,dispatch` y `DISPATCH_FAIL_CREATE=false`,
verificados. La compensación del fallo de Despacho incluye reembolso en Pagos y liberación de stock;
no se expone una orden pública. La pasarela simulada guarda estado en memoria y no hay dinero real.

### 10.4 Continuidad E3

Cuatro brazos × tres repeticiones (12 ejecuciones). Cada repetición recrea sólo `payments-api` para
limpiar contadores y aplica flags/timeout antes del warmup de una venta normal y su cancelación;
después mide. El deadline de Pagos es `1200 ms` fijo; la demora confirmable del simulador es
`650 ms`. Bulkhead usa cap experimental `2`, ráfaga de 6 ventas simultáneas y Circuit Breaker
apagado. Circuit Breaker usa simulador `down`, 8 POST secuenciales y Bulkhead apagado. En ambos
brazos se programa un `GET /v1/customers` en paralelo a la ráfaga o a los POST.

| Brazo | Protección | n POST | Estados POST | p50/p95/p99 POST (ms) | n GET | Estados GET | p50/p95/p99 GET (ms) |
|---|---|---:|---|---|---:|---|---|
| Bulkhead | activo | 18 | `6×201`, `12×503 PAYMENT_UNAVAILABLE` | 285.2 / 862.4 / 862.4 | 3 | `3×200` | 10.8 / 17.9 / 17.9 |
| Bulkhead | apagado | 18 | `18×201` | 786.5 / 800.7 / 800.7 | 3 | `3×200` | 21 / 24.9 / 24.9 |
| Circuit Breaker | activo | 24 | `24×503 PAYMENT_UNAVAILABLE` | 51.9 / 100.7 / 101.5 | 24 | `24×200` | 5.3 / 7.0 / 17.2 |
| Circuit Breaker | apagado | 24 | `24×503 PAYMENT_UNAVAILABLE` | 79.3 / 108.8 / 123.5 | 24 | `24×200` | 5.1 / 7.5 / 8.6 |

Mecanismo observado:

- Bulkhead activo: `peakInFlight=2` y 4 rechazos por repetición; apagado: 0 rechazos y todas las
  ventas `201`.
- Circuit Breaker activo: el simulador recibió `3/8` llamadas por repetición, el circuito abrió una
  vez y rechazó 5 llamadas por repetición. Apagado: `8/8` llamadas, 0 aperturas y 0 rechazos.
- Totales medidos por Gateway: 84 POST con cuerpo de negocio y 54 GET de clientes, todos los GET
  `200`; 0 respuestas `429` de rate limit.
- En los brazos de Circuit Breaker, el warmup de venta y cancelación añade dos llamadas exitosas al
  historial antes de medir. Eso explica que el circuito abra después de tres fallas sin alterar el
  mínimo configurado.
- Las latencias POST mezclan `201` y `503`; no se usan para afirmar que se aceleran cobros ni que una
  caída vende. Las muestras son pequeñas y no son SLO, capacidad ni benchmark.
- No se observó `HALF_OPEN` ni recuperación bajo carga medida más allá de la restauración.

### 10.5 Restauración y limpieza

| Elemento | Estado final |
|---|---|
| Simulador | `normal`, `latencyMs=20`, `slowDelayMs=3000` |
| Pagos | Circuit Breaker `true`, Bulkhead `true`, cap `8`, timeout `1200 ms` |
| Stock | Pieza de ráfaga `200 → 200`; pieza semilla `5 → 5`; verificado |
| Limpieza | 36 cancelaciones verificadas, incluidas 12 de warmup; 0 pendientes; 0 inciertas |

`restore.ok: true`. No se reinició el simulador, no se borraron volúmenes, no se detuvieron otros
proyectos y se conservaron red, volúmenes y registros de prueba. El runner puede repetir con la
misma `Idempotency-Key` bajo modo normal si una respuesta HTTP queda incierta, pero en esta corrida
no hubo respuestas inciertas ni recuperaciones: no se ejecutó el camino real de retry.

### 10.6 Pruebas automatizadas

| Suite | Resultado |
|---|---|
| Gateway (`npm test`) | 109 pruebas / 7 archivos |
| BFF (`npm test`) | 102 pruebas / 6 archivos |
| Nativas (`node --test`) | 76/76: smoke 29 + independent 29 + aggregation 6 + continuity 12 |
| **Total** | **287** |

`npm run typecheck` y `npm run build` pasaron en Gateway y BFF. No se ejecutó CI de GitHub y no se
hizo una auditoría npm nueva; la alerta histórica de §6 se conserva y no se presenta como resuelta.
Las 18 corridas directas de P2 son externas a E3 y se documentan en
[experiments/payments](../../experiments/payments/README.md); no se duplican sus cifras como
evidencia P4 ni se publican resultados de otro componente como propios.

### 10.7 Límites

- La corrida E3 es de mecanismo: 12 ejecuciones pequeñas, sin SLO, capacidad ni benchmark de Pagos.
- Las latencias POST agregan respuestas exitosas y rechazos; no miden sólo cobros aprobados.
- No se probó `HALF_OPEN` ni recuperación sostenida bajo carga medida.
- `GetPart` es una sonda de observabilidad; no prueba atomicidad de P1 ni orden temporal de efectos.
- No se ejecutó SQL desde P4, no se leyeron bases ajenas y no se alteró el Compose raíz.
- La integración final en el Compose raíz y la CI del grupo siguen pendientes de coordinación.
