# P4 — Especificación de exposición: Gateway y BFF

**Estado:** CERRADO en modo overlay local (2026-11-23). Gateway y BFF conservan su runtime y se
verificaron contra Pagos P2 **real** y la pasarela de pagos **simulada oficial**; la Saga P3 está
integrada y la corrida full quedó verificada. No hay dinero real. **Línea base histórica:**
`7daf5d0` (T1 + Despacho). **Base de esta fase:** `0edd96a` + cambios P4 locales.
**Alcance:** fijar el comportamiento observable del Gateway y del BFF. Las secciones 2–11 son la
especificación de transporte y rutas y no cambian; la evidencia actual está en
[VERIFICATION.md](VERIFICATION.md), §10, y el cierre se detalla en §16.

## 1. Alcance y decisiones

P4 agrega una capa de exposición sin reemplazar la API pública de T1:

- **T1:** `Cliente → Gateway → Sales API`. El Gateway autentica, autoriza, limita y reenvía.
- **Resumen:** `Cliente → Gateway → BFF → Pagos / Despacho`. El BFF sólo consulta y agrega.
- **T2-401 queda cerrado en modo overlay local.** Pagos P2 es un servicio real y la pasarela externa
  es simulada; la Saga/compensación pertenece a P3. El Gateway no cobra, no reserva stock y no
  compensa; el BFF no crea ni cancela despachos.
- **Sin persistencia duradera:** Gateway y BFF no tienen base de datos, Prisma, migraciones, Redis,
  broker, cola ni store compartido. La única excepción es el contador efímero del rate limit, por
  proceso, acotado y no replicado; `/health` no depende de ese contador.
- **Sin cambios a servicios ni contratos congelados:** no se modifica Sales, Inventory ni Despacho;
  tampoco `openapi.yaml`, `inventory.proto`, `AUTH.md` ni el Compose raíz. El contrato JWT y la ruta
  de resumen son contratos nuevos de exposición P4, documentados aquí.
- **Sin frontend, login, refresh tokens ni cuentas de usuario.** El JWT es una credencial de demo
  firmada localmente; no hay proveedor de identidad ni revocación más allá de `exp`.
- **Sin circuit breaker, bulkhead ni retries automáticos en Gateway/BFF.** Las protecciones P2
  (timeout, Circuit Breaker y Bulkhead) viven en Pagos y no se duplican en la capa de exposición.
  Sólo deadlines explícitos y recuperación basada en la idempotencia existente de T1.
- **Sin mocks de Pagos en runtime.** Pagos es el servicio P2 real; `payment-gateway-sim` es la
  pasarela externa simulada oficial del tercero, no un mock de Pagos. Las fixtures de pruebas siguen
  fuera del runtime.

## 2. Topología

```text
Cliente externo
      │  Authorization: Bearer <JWT demo>
      ▼
Gateway :8080  (único puerto host del overlay P4)
      ├── /v1/** (ocho operaciones T1) ──► Sales API :3000
      │                                      └── gRPC 800 ms ──► Inventory :50051
      └── /web/v1/orders/{orderId}/summary ──► BFF :3002
                                                 ├── GET /internal/v1/payments/{orderId}
                                                 │      └── Pagos :3003 (real P2)
                                                 │             └── pasarela simulada oficial
                                                 └── GET /internal/v1/dispatches/{orderId}
                                                        └── Despacho :3001 (real)
```

- Sales conserva su `X-API-Key` v1 y sigue siendo la única autoridad de clientes y órdenes. Inventory
  conserva su gRPC y su deadline de 800 ms; el Gateway nunca lo llama directamente.
- El BFF no llama a Sales: el resumen no afirma si la orden existe en Sales.
- Pagos y Despacho conservan sus propias bases; el BFF no lee ni escribe bases ajenas. La pasarela
  simulada no tiene base y guarda su estado en memoria.
- La red de Compose no es un límite de seguridad fuerte: la exposición se controla no publicando
  puertos host. `/internal` nunca se publica a través del Gateway.

## 3. Rutas y allowlist del Gateway

Además de su liveness propia y de la ruta nueva de resumen, el Gateway expone **exactamente las ocho
operaciones T1** del OpenAPI. No se renombran ni se agregan operaciones de Sales.

| Método | Ruta pública | Rol | Destino | Nota |
|---|---|---|---|---|
| GET | `/health` | público | Gateway | Liveness propia: `200 {status:"ok",service:"gateway"}`; no consulta dependencias. |
| GET | `/v1/health` | público | Sales `GET /v1/health` | Preserva cuerpo y traza de Sales. |
| POST | `/v1/customers` | `operator` | Sales | JSON; `Location` se preserva. |
| GET | `/v1/customers` | `reader` u `operator` | Sales | Query original preservada. |
| GET | `/v1/customers/{customerId}` | `reader` u `operator` | Sales | El UUID lo valida Sales. |
| POST | `/v1/orders` | `operator` | Sales | `Idempotency-Key` obligatoria, preservada. |
| GET | `/v1/orders` | `reader` u `operator` | Sales | Query original preservada. |
| GET | `/v1/orders/{orderId}` | `reader` u `operator` | Sales | El UUID lo valida Sales. |
| POST | `/v1/orders/{orderId}/cancel` | `operator` | Sales | Cancelación idempotente de T1. |
| GET | `/web/v1/orders/{orderId}/summary` | `reader` u `operator` | BFF, misma ruta | Ruta nueva P4; el BFF valida el UUID. |

Reglas de denegación:

- Ruta fuera de la allowlist: `404 NOT_FOUND`; método no permitido sobre ruta conocida:
  `405 METHOD_NOT_ALLOWED`. Nunca se elige un destino por el cliente ni se redirige.
- `/internal/**` no existe en el Gateway: con JWT válido devuelve `404`; sin JWT, `401` por el orden
  de autenticación. Tampoco se publica el `/health` interno del BFF.
- Se rechazan request-target absolutos, segmentos `..`, barras codificadas (`%2f`, `%5c`) y rutas
  ambiguas. La comparación es exacta, sensible a mayúsculas y sin barra final adicional.
- No se sigue ningún redirect del upstream. Un `3xx` se trata como respuesta inválida (`503`); no se
  reenvía `Location` ni se convierte en un destino controlado por el cliente.
- El Gateway no expone Inventory, ni rutas de Pagos/Despacho, ni CORS. Un frontend navegador queda
  fuera de P4.

Orden determinista: (1) validar request-target; (2) atender `/health` y `/v1/health` sin JWT ni rate
limit; (3) validar JWT (`401`); (4) aplicar allowlist (`404`/`405`); (5) autorizar rol (`403`);
(6) aplicar rate limit (`429`); (7) reenviar. Un rechazo de autenticación, ruta o rol no consume cuota
ni llega a un upstream.

## 4. Autenticación y autorización

### 4.1 Contrato JWT de demo

- Credencial: `Authorization: Bearer <jwt>`. No se acepta en query, cookie ni otro header.
- Algoritmo **HS256 fijo**. Se rechazan `none`, HS512, RS256 y cualquier algoritmo elegido por el
  token. La clave es un secreto de entorno de **al menos 32 bytes**, sin valor por defecto y nunca
  registrado en logs.
- Claims validados después de verificar la firma: `iss` y `aud` exactamente los valores configurados
  (`repuestossur-demo` y `repuestossur-gateway` por defecto); `exp` presente, entero y futuro; `sub`
  string no vacío; `role` exactamente `reader` o `operator` (sin arrays ni mayúsculas alternativas).
- El `sub` se usa exactamente como viene firmado. No se recorta ni se normaliza después de verificar
  la firma: un `sub` con espacios en los extremos (`sub !== sub.trim()`) se rechaza con `401`. El CLI
  recorta al emitir; el Gateway no equipara ` alice ` con `alice`.
- Faltante, malformado, firma inválida, `exp` vencido/ausente, `iss`/`aud` incorrectos, `sub` vacío,
  con espacios en los extremos o `role` inválido: `401 UNAUTHORIZED`, con
  `WWW-Authenticate: Bearer realm="repuestossur"` y sin llamar al upstream.
- El CLI local firma tokens HS256 con TTL de **15 minutos por defecto**, recibe `sub` y `role`, y usa
  el mismo secreto/issuer/audience. No implementa login, refresh, base de datos ni sesiones. El token
  se imprime sólo en la salida del comando; nunca se registra en logs.
- No hay revocación: un token es válido hasta `exp`. Es una limitación aceptada de la demo.

### 4.2 Roles y credenciales internas

| Rol JWT | GET | POST | Clave interna hacia Sales |
|---|---:|---:|---|
| `reader` | permitido | `403 FORBIDDEN` | `GATEWAY_SALES_API_KEY_READER` |
| `operator` | permitido | permitido | `GATEWAY_SALES_API_KEY_OPERATOR` |

- Las dos claves internas son obligatorias, no vacías y distintas. El Gateway las inyecta sólo al
  llamar a Sales; nunca las devuelve al cliente.
- `X-API-Key` externa **nunca autentica**. Si llega sola: `401`. Si llega junto a un JWT válido, el
  JWT decide la identidad, la clave externa se elimina y el Gateway la reemplaza por la clave interna
  del rol.
- `Authorization` y `X-API-Key` externas no llegan a Sales ni al BFF. Sales recibe únicamente su clave
  interna; el BFF no recibe credenciales del cliente.
- Los logs pueden incluir rol y un identificador no secreto del `sub`; nunca el token, las claves ni
  el secreto JWT.

## 5. Rate limit

- Se aplica **después** de verificar JWT y autorizar rol, a todas las rutas protegidas, incluida la
  ruta de resumen. `/health` y `/v1/health` no se limitan.
- Clave: `sub` verificado. Dos tokens del mismo `sub` comparten cuota; dos `sub` distintos tienen
  cuotas independientes. No se usa IP, `X-Forwarded-For`, `X-Real-IP` ni `Forwarded` para construir
  la clave ni para eludirla.
- Ventana fija de **60 s** y **60 solicitudes** por `sub`, configurables. La ventana se calcula desde
  el inicio de época; el contador es atómico dentro del proceso.
- Al superar la cuota: `429 RATE_LIMIT_EXCEEDED`, envelope `{code,message,traceId}` y `Retry-After`
  con los segundos reales que faltan para el final de la ventana (entero, mínimo 1). No se llama al
  upstream.
- Almacenamiento en memoria, monoinstancia. Se eliminan entradas vencidas periódicamente y se impone
  un máximo de identidades (`GATEWAY_RATE_LIMIT_MAX_IDENTITIES`). Al alcanzarlo no se desaloja una
  identidad activa, para no eludir la cuota: las nuevas reciben `429` hasta que expire la ventana más
  antigua; las existentes siguen operando. Sin Redis ni estado compartido; escalar horizontalmente
  exigiría un store compartido y queda fuera de alcance.

## 6. Proxy HTTP

### 6.1 Solicitud

- Se preservan método, path permitido, query original y cuerpo JSON sin cambiar su semántica. El
  cuerpo se reenvía byte a byte, con el mismo `Content-Type`; no se normaliza, reordena ni
  re-serializa. La validación semántica sigue siendo de Sales.
- `Idempotency-Key` se reenvía exactamente. El Gateway no genera, cachea, deduplica ni reinterpreta
  idempotencia; Sales sigue siendo la autoridad de replay/conflicto.
- Sólo se aceptan cuerpos JSON en POST con body. JSON malformado, `Content-Type` ausente/incorrecto o
  body en GET: `400 VALIDATION_ERROR`. Cuerpo mayor a **1 MiB**: `413 PAYLOAD_TOO_LARGE` (código
  específico de P4; no cambia el contrato de Sales). El límite es inclusivo.
- Se eliminan cabeceras hop-by-hop (`Connection`, `Keep-Alive`, `Proxy-Authenticate`,
  `Proxy-Authorization`, `TE`, `Trailer`, `Transfer-Encoding`, `Upgrade`) y credenciales externas
  (`Authorization`, `X-API-Key`, `Cookie`, `X-Forwarded-*`, `Forwarded`, `X-Trace-Id` entrante).
  Se conservan `Content-Type`, `Accept` e `Idempotency-Key`; el `Host` es el del upstream.
- `Accept` es una cabecera de lista: se combinan todos sus valores crudos, en orden, con `', '` antes
  de reenviar. `Authorization`, `Content-Type` e `Idempotency-Key` son singleton: `Authorization`
  duplicada → `401`; `Content-Type` o `Idempotency-Key` duplicadas → `400`.
- Las base URLs son HTTP(S), configuradas, sin usuario/contraseña, query ni fragmento. No se aceptan
  URLs controladas por el cliente. El cliente HTTP usa `redirect: 'manual'`; no sigue redirects.

### 6.2 Respuesta

- Se preservan status, cuerpo JSON, `Content-Type`, `Location`, `Idempotency-Replayed` y `X-Trace-Id`
  del upstream correspondiente. No se reescribe `Location` con el host del Gateway.
- Se eliminan cabeceras hop-by-hop. Un cuerpo mayor a **2 MiB**, JSON inválido, `Content-Type` no
  JSON, `3xx` o respuesta de red inválida se tratan como fallo de upstream:
  `503 UPSTREAM_UNAVAILABLE`; el motivo real sólo se registra internamente.
- Los errores de negocio de Sales (`400`, `404`, `409`, `422`) y sus fallos (`500`, `503`, `504`) se
  preservan con su cuerpo y `traceId`; no se envuelven ni se reinterpretan. Excepción: un `401`/`403`
  de Sales sólo puede deberse a la credencial interna mal configurada; se registra y se devuelve
  `503 UPSTREAM_UNAVAILABLE` para no presentar al cliente un desafío de API key interna.
- No se filtran stack traces, SQL, mensajes de gRPC ni cuerpos internos. El Gateway no reintenta: un
  `503`/`504` local no repite la llamada.

## 7. Timeouts y semántica de fallo

| Salto | Deadline | Configuración |
|---|---:|---|
| Gateway → Sales (T1) | 10 000 ms | `GATEWAY_SALES_TIMEOUT_MS` |
| Gateway → BFF (resumen) | 2 500 ms | `GATEWAY_BFF_TIMEOUT_MS` |
| BFF → cada fuente (Pagos/Despacho) | 1 500 ms en paralelo | `BFF_SOURCE_TIMEOUT_MS` |
| Sales → Inventory (sin cambios) | 800 ms | `INVENTORY_RPC_DEADLINE_MS` |

- El deadline cubre conexión, cabeceras y cuerpo completo. Al vencer se aborta la conexión y se
  responde `504 UPSTREAM_TIMEOUT`; no hay retry automático.
- **Un timeout HTTP del proxy no revierte ni cancela una mutación que el servidor ya ejecutó.** Si
  `POST /v1/orders` o la cancelación quedan ambiguos, el cliente debe reintentar con la misma
  `Idempotency-Key` (creación) o repetir la cancelación idempotente de T1. El Gateway no compensa, no
  libera stock y no promete que el efecto no ocurrió.
- El presupuesto de la Saga y la recuperación de pagos/despachos están definidos en P3; P4 no
  implementa compensaciones ni estados públicos nuevos.
- Errores locales de upstream: `503 UPSTREAM_UNAVAILABLE` para red/DNS/TLS, respuesta inválida, `3xx`
  o cuerpo excesivo; `504 UPSTREAM_TIMEOUT` para deadline. Ambos con envelope
  `{code,message,traceId}` y mensaje genérico.

## 8. Trazas y correlación

- **Sales genera siempre un UUID nuevo** por solicitud y lo pone en `X-Trace-Id` y, cuando aplica, en
  `body.traceId`. El Gateway **no lo modifica ni lo reemplaza**.
- El Gateway genera su propio `gatewayRequestId` para logs. En T1 registra `gatewayRequestId` +
  `upstreamTraceId` (el de Sales); no promete un UUID único de extremo a extremo.
- En resumen, el Gateway envía su `gatewayRequestId` como `X-Trace-Id` al BFF. El BFF valida que sea
  UUID; si falta o es inválido, genera uno propio. El BFF propaga ese UUID validado a Despacho y lo
  devuelve en `X-Trace-Id`.
- Errores propios del Gateway o del BFF: el UUID local es idéntico en `X-Trace-Id` y `body.traceId`.
  Errores proxied de Sales conservan la traza de Sales; los del BFF conservan la del BFF.
- Un `X-Trace-Id` del cliente no se confía ni se reenvía; se elimina y se generan trazas internas. La
  correlación se hace por logs, no por un identificador único compartido por todos.

## 9. BFF: resumen de orden

### 9.1 Ruta, liveness y esquema

- `GET /web/v1/orders/{orderId}/summary` en el BFF, misma ruta que publica el Gateway (traducción
  1:1, sin prefijo adicional). Sólo `GET`.
- `GET /health` interno del BFF: `200 {status:"ok",service:"web-bff"}`, sin consultar Pagos ni
  Despacho. No se publica por el Gateway.
- El BFF valida `orderId` como UUID; si no lo es: `400 VALIDATION_ERROR`, sin llamar a las fuentes.

```json
{
  "orderId": "4f4c2c1e-6d7a-4f5e-9d5e-0f6a7b8c9d0e",
  "partial": false,
  "payment": {
    "availability": "available",
    "data": {
      "orderId": "4f4c2c1e-6d7a-4f5e-9d5e-0f6a7b8c9d0e",
      "status": "CHARGED"
    }
  },
  "dispatch": {
    "availability": "available",
    "data": {
      "orderId": "4f4c2c1e-6d7a-4f5e-9d5e-0f6a7b8c9d0e",
      "status": "CREATED",
      "items": [{ "partId": "9a7b6c5d-4e3f-4a2b-8c1d-0e9f8a7b6c5d", "quantity": 2 }]
    }
  }
}
```

- `availability` sólo puede ser `available`, `not_found`, `unavailable` o `timeout`.
- `data` existe **sólo** si `availability` es `available`, la respuesta HTTP fue real, el JSON es
  válido y su `orderId` coincide con el de la ruta (UUID normalizado).
- `payment.data` publica únicamente `orderId` y `status`; `dispatch.data` publica `orderId`, `status`
  e `items`. No se copian campos adicionales del upstream.
- **No se publican `amountMinor` ni `currency`**: P4 no los inventa, no los infiere y no los usa para
  decidir el estado. Tampoco se publica un campo `sales`.
- `partial` es `false` sólo cuando ambas fuentes están `available`; en cualquier otro `200` con al
  menos una disponible es `true`. Describe disponibilidad de datos, no éxito de negocio: un pago
  `DECLINED` sigue siendo `available`.

### 9.2 Resultado y errores

| payment | dispatch | Resultado |
|---|---|---|
| `available` | cualquiera | `200`, `partial` según ambas |
| cualquiera | `available` | `200`, `partial` según ambas |
| `timeout` | `not_found`/`unavailable`/`timeout` | `504 UPSTREAM_TIMEOUT` |
| `not_found`/`unavailable` | `timeout` | `504 UPSTREAM_TIMEOUT` |
| `unavailable` | `not_found`/`unavailable` | `503 UPSTREAM_UNAVAILABLE` |
| `not_found` | `unavailable` | `503 UPSTREAM_UNAVAILABLE` |
| `not_found` | `not_found` | `404 SUMMARY_NOT_FOUND` |

Precedencia cuando ninguna fuente está disponible: cualquier `timeout` → `504`; si no, cualquier
`unavailable` → `503`; si no, ambas `not_found` → `404`. Un `404` de resumen significa que ninguna
fuente tiene registro; **no afirma que la orden no exista en Sales**. La existencia se verifica con
`GET /v1/orders/{orderId}` en Sales.

Errores del BFF con envelope `{code,message,traceId}`:

- `400 VALIDATION_ERROR`: `orderId` no es UUID.
- `404 SUMMARY_NOT_FOUND`: ambas fuentes `not_found`.
- `503 UPSTREAM_UNAVAILABLE`: al menos una fuente `unavailable` y ninguna `available` ni `timeout`.
- `504 UPSTREAM_TIMEOUT`: al menos una fuente `timeout` y ninguna `available`.

`503`/`504` pueden incluir `details.sources` con los cuatro valores de disponibilidad, sin cuerpos,
URLs, mensajes ni excepciones de las fuentes. No se incluye `partial` en errores.

## 10. Adaptadores de fuentes

### 10.1 Pagos (P2 real)

- `GET {BFF_PAYMENTS_BASE_URL}/internal/v1/payments/{orderId}`. La ruta y los estados son el
  contrato interno P2 implementado.
- Estados aceptados: `CHARGED`, `DECLINED`, `REFUNDED`, `PENDING`, `REFUND_PENDING`. Cualquier otro,
  ausente o con tipo incorrecto hace que la fuente sea `unavailable`.
- Se validan estrictamente `orderId` (debe coincidir) y `status`. Los campos adicionales se ignoran y
  nunca se publican. `amountMinor`/`currency` no son obligatorios, no se inventan y no se publican.
- `200` válido → `available`; `404` → `not_found`; `3xx`, `4xx` distinto de 404, `5xx`, JSON inválido,
  `orderId` incorrecto o cuerpo excedido → `unavailable`; deadline → `timeout`.
- Un pago ausente (`404`) **nunca** se convierte en `CHARGED` ni en un cobro aprobado. P4 no cobra, no
  reembolsa ni consulta mutaciones.

### 10.2 Despacho (real)

- `GET {BFF_DISPATCH_BASE_URL}/internal/v1/dispatches/{orderId}`.
- `200` válido: `orderId` coincide; `status` es `CREATED` o `CANCELLED`; `items` es un array no vacío
  de `{partId: UUID, quantity: entero positivo}` con `partId` únicos. Campos adicionales se ignoran.
- `404` → `not_found`; `3xx`, otros `4xx`, `5xx`, JSON inválido, `orderId` incorrecto o cuerpo
  excedido → `unavailable`; deadline → `timeout`. P4 no crea, no cancela y no modifica despachos.
- El BFF propaga a Despacho el UUID interno validado en `X-Trace-Id`; Despacho lo devuelve si es
  válido. La correlación no depende de headers del cliente.

Ambos adaptadores usan `redirect: 'manual'`, verifican TLS cuando la URL es HTTPS, aplican el deadline
de 1 500 ms y no reintentan. Las fixtures de Pagos/Despacho existen sólo en pruebas; no hay una rama
de mock en el código de runtime.

## 11. Configuración

Nombres actuales de configuración de Gateway y BFF. Todos se validan al arrancar; un valor inválido
impide iniciar y el mensaje nombra la variable y la regla, nunca su valor.

| Variable | Default | Consumidor / regla |
|---|---|---|
| `GATEWAY_HOST` | `0.0.0.0` | Gateway; host no vacío. |
| `GATEWAY_PORT` | `8080` | Gateway; entero 1–65535. |
| `GATEWAY_SALES_BASE_URL` | — | Gateway; URL HTTP(S) sin userinfo/query/fragment. |
| `GATEWAY_BFF_BASE_URL` | — | Gateway; URL HTTP(S) sin userinfo/query/fragment. |
| `GATEWAY_JWT_SECRET` | — | Gateway/CLI; al menos 32 bytes; nunca se registra. |
| `GATEWAY_JWT_ISSUER` | `repuestossur-demo` | Gateway/CLI; valor exacto esperado. |
| `GATEWAY_JWT_AUDIENCE` | `repuestossur-gateway` | Gateway/CLI; valor exacto esperado. |
| `GATEWAY_SALES_API_KEY_READER` | — | Gateway; no vacía, distinta de operator. |
| `GATEWAY_SALES_API_KEY_OPERATOR` | — | Gateway; no vacía, distinta de reader. |
| `GATEWAY_SALES_TIMEOUT_MS` | `10000` | Gateway; entero positivo. |
| `GATEWAY_BFF_TIMEOUT_MS` | `2500` | Gateway; entero positivo. |
| `GATEWAY_RATE_LIMIT_WINDOW_MS` | `60000` | Gateway; entero positivo. |
| `GATEWAY_RATE_LIMIT_MAX_REQUESTS` | `60` | Gateway; entero positivo. |
| `GATEWAY_RATE_LIMIT_MAX_IDENTITIES` | `10000` | Gateway; entero positivo. |
| `GATEWAY_MAX_REQUEST_BODY_BYTES` | `1048576` | Gateway; entero positivo. |
| `GATEWAY_MAX_RESPONSE_BODY_BYTES` | `2097152` | Gateway; entero positivo. |
| `BFF_HOST` | `0.0.0.0` | BFF; host no vacío. |
| `BFF_PORT` | `3002` | BFF; entero 1–65535. |
| `BFF_PAYMENTS_BASE_URL` | — | BFF; URL HTTP(S) sin userinfo/query/fragment. |
| `BFF_DISPATCH_BASE_URL` | — | BFF; URL HTTP(S) sin userinfo/query/fragment. |
| `BFF_SOURCE_TIMEOUT_MS` | `1500` | BFF; entero positivo. |
| `BFF_MAX_RESPONSE_BODY_BYTES` | `2097152` | BFF; entero positivo por fuente. |

Reglas adicionales:

- El algoritmo JWT no es configurable: es HS256. No se acepta `NODE_TLS_REJECT_UNAUTHORIZED=0`.
- No se consulta la conectividad de los upstreams al arrancar: la liveness es independiente y un
  upstream caído se refleja como `503`/`unavailable`, no como fallo de inicio.
- Los límites de 1 MiB/2 MiB, el rate limit y los códigos `PAYLOAD_TOO_LARGE`/`METHOD_NOT_ALLOWED`
  son específicos de la capa de exposición P4; no modifican el contrato ni el comportamiento de Sales
  cuando se le llama directamente.
- `GATEWAY_SALES_API_KEY_READER` y `GATEWAY_SALES_API_KEY_OPERATOR` son nombres de variables
  distintos de `API_KEY_READER`/`API_KEY_OPERATOR` de Sales. Sus valores deben coincidir
  respectivamente con los que Sales espera, y el valor de reader debe ser distinto del de operator.
  El overlay local los pasa sin versionarlos.

## 12. Empaquetado opt-in

- El Compose raíz **no se modifica por P4** y ya contiene P1–P3: Sales, Inventory, Dispatch, Pagos
  real, pasarela simulada y la Saga P3. Conserva `SAGA_STEPS=stock` por defecto. La integración final
  en un único `docker compose up --build` y la CI del grupo quedan pendientes de coordinación.
- El empaquetado P4 usa un overlay separado, `docker-compose.p4.yml`, de forma opt-in:
  `docker compose -f docker-compose.yml -f docker-compose.p4.yml up --build`.
- En el overlay P4, **el único puerto host es el del Gateway** (`8080` por defecto, `8082` en la
  corrida). Sales, Inventory, BFF, Despacho, Pagos y la pasarela simulada quedan internos; el overlay
  retira los puertos host que el Compose raíz publica para Sales/Inventory y los de perfiles de
  experimento/test. No se agregan volúmenes ni bases nuevas.
- Gateway y BFF tienen healthchecks de liveness (`/health`) sin dependencias. Un upstream caído no
  impide arrancar ni que `/health` responda `200`.
- Pagos es el servicio real de P2 y `payment-gateway-sim` la pasarela externa simulada oficial. El
  BFF apunta a `payments-api`; no hay mock de Pagos en Compose ni cobro real. Los 11 servicios del
  stack full quedan healthy con sólo el Gateway publicado.

## 13. Matriz mínima de pruebas

Criterios de aceptación; la evidencia real está en [VERIFICATION.md](VERIFICATION.md), §10. Las
pruebas unitarias y de integración de Gateway/BFF usan stubs HTTP locales en `127.0.0.1:0` (puertos
efímeros) y un reloj controlado para rate limit; no requieren Docker ni Pagos. En esas pruebas Pagos
se simula con fixtures. La integración real se cubre en el runner P4 con el servicio Pagos real y la
pasarela simulada oficial. El smoke P4 usa Sales, Inventory, Pagos y Despacho reales cuando el modo
lo usa; la pasarela externa es simulada. La fixture sintética de Despacho es opcional sólo en `stock`
y no es evidencia de Saga. Cada escenario que llega al upstream verifica que recibió **una sola**
llamada, para demostrar ausencia de retry.

### 13.1 Gateway: autenticación y autorización

| ID | Escenario | Resultado esperado |
|---|---|---|
| A01 | Sin `Authorization` | `401`, `WWW-Authenticate: Bearer`, sin upstream. |
| A02 | Esquema distinto de Bearer, token malformado o múltiples credenciales | `401`, sin upstream. |
| A03 | `alg:none`, HS512 o RS256 | `401`; nunca se acepta el algoritmo del token. |
| A04 | Firma inválida | `401`, sin detalles de la causa. |
| A05 | `exp` ausente, vencido o no entero | `401`. |
| A06 | `iss` o `aud` incorrectos/ausentes | `401`. |
| A07 | `sub` vacío/no string/con espacios en los extremos; `role` ausente, desconocido o array | `401`. |
| A08 | `reader` en GET vs POST; `operator` en POST | GET permitido; POST de reader `403`; POST de operator permitido. |
| A09 | Sólo `X-API-Key` externa; JWT válido + `X-API-Key` externa | Sólo key: `401`; ambos: gana JWT y se elimina la key externa. |
| A10 | Stub de Sales inspecciona cabeceras | Recibe la clave interna del rol, sin `Authorization`/`X-API-Key` externas. |
| A11 | Token en query/cookie; token en logs | No autentica (`401`); el token nunca aparece en logs. |

### 13.2 Gateway: allowlist, proxy e idempotencia

| ID | Escenario | Resultado esperado |
|---|---|---|
| P01 | Las ocho operaciones T1 y la ruta de resumen | Cada una llega al destino correcto con método/path/query/body exactos. |
| P02 | Ruta desconocida o método no permitido con JWT válido | `404`/`405`, sin upstream. |
| P03 | Con JWT válido: `/internal/**`, traversal, `%2f`, `%5c`, request-target absoluto | Denegado (`404`/`400`), sin upstream ni redirect. |
| P04 | Upstream responde `3xx` | `503`, no se sigue ni se reenvía `Location`. |
| P05 | `POST /v1/orders` con `Idempotency-Key`; Sales 201 y replay 201 | Header y cuerpo preservados; `Idempotency-Replayed` visible; sin deduplicación del Gateway. |
| P06 | Sales devuelve `Location`, `X-Trace-Id`, `body.traceId` y JSON de error | Se preservan status/cuerpo/cabeceras; no se reescribe la traza. |
| P07 | Cabeceras hop-by-hop y credenciales externas | Se eliminan; no llegan al upstream. |
| P08 | JSON malformado, content-type incorrecto/ausente, GET con body, cuerpo >1 MiB | `400`/`413`, sin upstream; 1 MiB exacto se acepta. |
| P09 | Red caída, timeout, cuerpo lento, respuesta >2 MiB o JSON inválido | `503`/`504`; una sola llamada al upstream; sin detalles internos. |
| P10 | Sales devuelve `400/404/409/422/500/503/504` | Se preservan status, código, mensaje y `traceId`. |
| P11 | Query con parámetros repetidos/codificados | Se reenvía la query original sin reordenar. |
| P12 | `401/403` de Sales por credencial interna | `503 UPSTREAM_UNAVAILABLE`; no se presenta el desafío de API key al cliente. |
| P13 | `Accept` en dos cabeceras | Se combinan en orden con `, `; el upstream recibe la lista completa. |
| P14 | `Idempotency-Key` duplicada con payload válido | `400`, sin upstream. |

### 13.3 Rate limit

| ID | Escenario | Resultado esperado |
|---|---|---|
| R01 | 60 solicitudes en la ventana; la 61.ª | Las 60 pasan; la 61.ª `429` con envelope y `Retry-After` real (1–60 s); sin upstream. |
| R02 | Dos tokens con el mismo `sub`; dos `sub` distintos | Mismo `sub` comparte cuota; `sub` distintos son independientes. |
| R03 | Reloj controlado: cruce de ventana y `Retry-After` | La cuota se reinicia al inicio de la ventana; `Retry-After` decrece y no hay off-by-one. |
| R04 | 100 solicitudes concurrentes con límite 60 | Exactamente 60 llegan al upstream y 40 reciben `429`. |
| R05 | `/health`, `/v1/health`, `401`, `403`, `404` | Health no se limita; los rechazos previos no consumen cuota. |
| R06 | `X-Forwarded-For`/`X-Real-IP` falsificados | No cambian la clave ni permiten eludir la cuota. |
| R07 | Cap de identidades pequeño; ventana vencida | Identidad nueva recibe `429` al llenarse; las existentes siguen; las vencidas se limpian y la memoria queda acotada. |

### 13.4 BFF: resumen y adaptadores

| ID | Escenario | Resultado esperado |
|---|---|---|
| B01 | Ambas fuentes `200` válidas con el mismo `orderId` | `200`, `partial:false`, ambos `data`. |
| B02 | Una fuente `available` y la otra `not_found`, `unavailable` o `timeout` | `200`, `partial:true`; sólo la disponible lleva `data`. |
| B03 | Ambas `404` | `404 SUMMARY_NOT_FOUND`; no se llama a Sales ni se afirma que la orden no exista. |
| B04 | `not_found` + `unavailable`; `not_found` + `timeout`; ambas `unavailable`; ambas `timeout` | `503`, `504`, `503`, `504` respectivamente. |
| B05 | JSON malformado, `orderId` incorrecto, estado desconocido/ausente, tipos incorrectos | Fuente `unavailable`; si la otra está disponible, `200 partial:true`; si no, `503`. |
| B06 | Fuente `500`, `3xx`, `404` o timeout | `unavailable`, `unavailable`, `not_found`, `timeout`; sin retry. |
| B07 | `orderId` no UUID | `400 VALIDATION_ERROR`, sin llamadas a fuentes. |
| B08 | Dos fuentes lentas cerca del deadline | Se llaman en paralelo; el tiempo total se acerca al máximo (1 500 ms), no a la suma. |
| B09 | Esquema de éxito | Sólo `orderId`, `partial`, `payment`, `dispatch`; sin `amountMinor`/`currency` ni extras del upstream. |
| B10 | Estados de Pagos y Despacho | Se aceptan los cinco de Pagos y `CREATED`/`CANCELLED`; cualquier otro es `unavailable`. |
| B11 | Pagos `404` con Despacho disponible | `200 partial:true`; pago `not_found` sin `data`; nunca se convierte en `CHARGED`. |
| B12 | `X-Trace-Id` válido/inválido hacia Despacho | Se propaga el UUID validado; si falta o es inválido, el BFF genera uno. |
| B13 | `/health` del BFF con fuentes caídas | `200` sin consultar Pagos/Despacho. |
| B14 | Runtime sin Pagos desplegado | La fuente queda `unavailable`; no existe mock de Pagos en runtime ni éxito simulado. |

### 13.5 Configuración, trazas, salud y empaquetado

| ID | Escenario | Resultado esperado |
|---|---|---|
| C01 | Secreto <32 bytes, claves internas iguales, URL con userinfo/query/fragment, timeout/límite inválido | El proceso no arranca; el mensaje nombra la variable, nunca el valor. |
| C02 | Config válida con upstreams apagados | Gateway/BFF arrancan; `/health` responde `200`; no hay chequeo de conectividad al inicio. |
| C03 | Traza de Sales, error local del Gateway/BFF | Sales se preserva; error local usa el mismo UUID en header y body; logs correlacionan sin prometer UUID único. |
| C04 | `/health` vs `/v1/health` vs Sales health | Gateway/BFF liveness no dependen de upstreams; `/v1/health` refleja a Sales; Sales directo sigue público. |
| C05 | Overlay P4 | `docker compose ... config` válido; sólo Gateway publica `8080`; raíz intacta; sin volúmenes/DB nuevos. |
| C06 | Contratos y regresión T1 | Sin diff en OpenAPI/proto/AUTH.md; lint/contract checks pasan; Sales directo conserva su `X-API-Key` y el deadline de Inventory sigue en 800 ms. |
| C07 | Logs de errores y credenciales | Sin tokens, claves, secretos, cuerpos internos, SQL ni stack traces. |

## 14. Verificación de línea base citada

Snapshot de la línea base T1/Despacho citado durante la especificación. **No es evidencia de
Gateway, BFF, Pagos ni Saga**:

- `docker compose config --quiet`: exitoso.
- `docker compose up --build -d --wait`: exitoso; seis contenedores levantados.
- Sales `GET /v1/health` sin key: `200` (health es público y no requiere key).
- `GET /v1/customers` sin key: `401`; con `reader` en GET: `200`.
- `POST /v1/customers` con `reader`: `403`.
- `apps/dispatch-api/test/dispatch.integration.mjs`: 4 pruebas pasaron.

La verificación P4 previa (Gateway, BFF, overlay y smoke sobre `7daf5d0`) está en
[VERIFICATION.md](VERIFICATION.md). Pagos y Saga no se verificaron allí.

La evidencia actual de la base `0edd96a` + delta P4 sin commit está en
[VERIFICATION.md](VERIFICATION.md), §10. Incluye la corrida full con Pagos real y pasarela simulada,
el fallo de Despacho con compensación y E3. La corrida previa sin Pagos de §9 se conserva como
histórica; la línea base `7daf5d0` de arriba también.

## 15. Cierre y pendientes de coordinación

P4 queda cerrado en modo overlay local. La evidencia está en [VERIFICATION.md](VERIFICATION.md),
§10. No hay que rehacer las protecciones P2 ni la Saga P3: ambas se verificaron en la corrida full y
en E3. Queda pendiente de coordinación con el grupo:

- Integrar el overlay en el Compose raíz y en la CI, con una decisión explícita sobre el
  `SAGA_STEPS` por defecto.
- Publicar o grabar la demo si el equipo decide convertir el guion en video.

Fuera de alcance de P4: TLS/ingress, frontend, login/refresh, CORS, rate limit compartido entre
instancias y cualquier evidencia de producción, capacidad o SLO.

**T2-401 queda cerrado en modo overlay local**, no así la integración final en el Compose raíz ni la
CI del grupo.

## 16. Cierre P4: Pagos real, pasarela simulada y DOC-01

**DOC-01 (Muse) — obligatorio:** esta sección es la fuente de cierre documental de P4. Las
menciones anteriores de este documento que describían Pagos como pendiente o ausente quedaron
actualizadas; las secciones 2–11 conservan la especificación de transporte y rutas sin cambios.

La corrida final (2026-11-23) usó el proyecto `repuestossur-p4-final`, puerto `8082`, 11 servicios
healthy y sólo `127.0.0.1:8082` publicado. Pagos es el servicio real de P2; `payment-gateway-sim` es
la pasarela externa simulada oficial. No hay dinero real.

Tres modos y cuatro escenarios verificados:

- `stock`: resumen `404 SUMMARY_NOT_FOUND` con Pagos y Despacho `not_found`; stock `5 → 5`.
- `stock,dispatch`: resumen `200 partial:true`, Pagos `not_found`, Despacho `CREATED`; cancelación
  `CANCELLED`; stock `5 → 5`.
- `stock,payment,dispatch`: creación `201 CONFIRMED`, replay `201` con el mismo cuerpo, conflicto
  `409`; resumen `200 partial:false` con Pagos `CHARGED` y Despacho `CREATED`, misma orden/items y
  sin campos extra de Pagos; doble cancelación deja Pagos `REFUNDED` y Despacho `CANCELLED`; stock
  `5 → 5`; deltas de la pasarela `+1` cobros, `+1` reembolsos, `0` anulaciones.
- `DISPATCH_FAIL_CREATE=true` con full: `503 DISPATCH_UNAVAILABLE`; el replay con la misma
  `Idempotency-Key` devuelve el mismo código/mensaje; cero órdenes públicas; `GET /v1/customers`
  `200`; stock `5 → 5 → 5`; delta del primer fallo `1/1/0` y del replay `0/0/0`.

E3 comparó Bulkhead y Circuit Breaker de Pagos con 3 repeticiones por brazo, warmup de una venta
normal por repetición y deadline fijo de `1200 ms`. Bulkhead: simulador `slow` con `650 ms`, cap
experimental `2`, ráfaga de 6 ventas y GET de clientes en paralelo; protegido `6×201/12×503`, pico
`2` y 4 rechazos por repetición; sin protección `18×201` y 0 rechazos. Circuit Breaker: simulador
`down`, 8 POST secuenciales por repetición y GET de clientes en paralelo; protegido y sin protección
`24×503`, pero con protección el simulador recibió `3/8` por repetición y el circuito abrió una vez;
sin protección recibió `8/8` y no hubo aperturas. La corrida total fue 84 POST de negocio y 54 GET
de clientes, con 0 rate limit. Los percentiles están en [VERIFICATION.md](VERIFICATION.md), §10; no
son un SLO ni una prueba de capacidad.

Restauración: simulador `normal`, latencia `20 ms`, `slowDelayMs=3000`; Pagos con CB/BH `true`, cap
`8`, timeout `1200`; stock `200 → 200` y `5 → 5`; 36 cancelaciones verificadas, incluidas 12 de
warmup, con cero pendientes o inciertas. No se reinició el simulador, no se borraron volúmenes y no
se detuvieron otros proyectos.

Límites: muestras pequeñas; las latencias POST mezclan `201` y `503`; no se observó `HALF_OPEN` bajo
carga medida más allá de la restauración; las 18 corridas directas de P2 son externas a E3 y se
documentan en [experiments/payments](../../experiments/payments/README.md), sin duplicar sus cifras
como evidencia P4. No se ejecutó CI de GitHub ni una auditoría npm nueva. La integración en el
Compose raíz y la CI del grupo siguen siendo responsabilidad de coordinación.
