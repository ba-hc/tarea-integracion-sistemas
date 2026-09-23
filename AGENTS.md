# AGENTS.md - RepuestosSur

Este archivo define las reglas operativas para agentes de programación y contribuciones al proyecto RepuestosSur.

## 1. Objetivo del proyecto

Integrar dos sistemas independientes:

- **Sales API**: API REST pública para clientes y órdenes de venta.
- **Inventory Service**: servicio gRPC interno que posee el catálogo de piezas y el stock actual.

Una orden de venta se confirma sólo cuando Inventory reserva de forma atómica el stock de todos los ítems solicitados. Cada servicio posee su propia base PostgreSQL. El sistema final debe iniciar con un único `docker compose up --build`.

## 2. Fuentes autoritativas

Leer antes de modificar comportamiento:

1. `contracts/rest/openapi.yaml`
2. `contracts/grpc/repuestossur/inventory/v1/inventory.proto`
3. `docs/architecture/SYSTEM-DESIGN.md`
4. `docs/architecture/ERROR-MAPPING.md`
5. `docs/architecture/AUTH.md`
6. `docs/architecture/RELIABILITY.md`
7. `docs/architecture/DATA-OWNERSHIP.md`
8. `docs/architecture/TEST-MATRIX.md`
9. `docs/adr/ADR-001-service-boundaries.md` a `ADR-004-resilience.md`

Si el código contradice estas fuentes, prevalece el contrato o la decisión arquitectónica aceptada hasta que exista un cambio deliberado y documentado.

## 3. Línea base congelada

El tag previsto para la línea base es:

```text
contracts-v1.0.0
```

Después de ese tag:

- No renombrar endpoints, RPCs, campos, códigos de error públicos, roles, servicios o headers requeridos sólo para simplificar una implementación.
- No modificar `openapi.yaml` o `inventory.proto` como efecto lateral de un cambio de aplicación.
- Los cambios compatibles requieren un PR dedicado de contrato y actualización de pruebas/documentación afectada.
- Los cambios incompatibles requieren `/v2` o `inventory.v2`, notas de migración y nuevas pruebas.

## 4. Invariantes arquitectónicos

```text
Cliente externo
      |
      | REST / JSON /v1
      v
  Sales API -----------------> Sales PostgreSQL
      |
      | unary gRPC / Protobuf
      | deadline: 800 ms
      v
Inventory Service -----------> Inventory PostgreSQL
```

Reglas que no deben violarse:

- Sales nunca lee ni escribe la base de Inventory.
- Inventory nunca lee ni escribe la base de Sales.
- No existen tablas de negocio compartidas ni foreign keys SQL entre servicios.
- Inventory es la única autoridad que muta el stock actual.
- Inventory gRPC es interno; clientes externos usan Sales REST.
- `ReserveStock` es atómico para todos los ítems de una orden: todos se reservan o ninguno cambia el stock.
- `ReserveStock` y `ReleaseStock` son idempotentes por `order_id`.
- Una creación fallida no expone una orden pública `PENDING`.
- Una cancelación sólo pasa a `CANCELLED` después de liberar el stock correctamente.

## 5. Comportamiento público congelado

### REST

```text
GET  /v1/health
POST /v1/customers
GET  /v1/customers
GET  /v1/customers/{customerId}
POST /v1/orders
GET  /v1/orders
GET  /v1/orders/{orderId}
POST /v1/orders/{orderId}/cancel
```

### Autenticación

Header:

```http
X-API-Key: <secret>
```

Roles:

- `reader`: sólo GET.
- `operator`: GET + POST.
- Key ausente o inválida -> 401.
- Key válida `reader` sobre POST -> 403.
- `/v1/health` es público.

### Creación de órdenes

`POST /v1/orders` requiere `Idempotency-Key`.

- Misma key + misma solicitud normalizada -> reproducir el mismo resultado sin un segundo descuento de stock.
- Misma key + payload diferente -> 409 `IDEMPOTENCY_KEY_CONFLICT`.

Estados públicos de orden:

```text
CONFIRMED -> CANCELLED
```

### gRPC

Implementar exactamente:

```text
GetPart
ListParts
ReserveStock
ReleaseStock
```

Usar RPC unary y el package `repuestossur.inventory.v1`.

### Mapeo de errores

| Condición | Resultado REST |
|---|---|
| request inválida | 400 `VALIDATION_ERROR` |
| customer/order inexistente | 404 |
| stock insuficiente | 409 `INSUFFICIENT_STOCK` |
| pieza inexistente | 422 `PART_NOT_FOUND` |
| Inventory no disponible | 503 `INVENTORY_UNAVAILABLE` |
| deadline de 800 ms excedido | 504 `INVENTORY_TIMEOUT` |
| falla interna inesperada | 500 `INTERNAL_ERROR` |

Envelope público:

```json
{
  "code": "INVENTORY_UNAVAILABLE",
  "message": "Inventory service is unavailable",
  "traceId": "uuid"
}
```

Nunca exponer SQL crudo, errores Prisma, stack traces ni detalles internos de gRPC al cliente REST.

## 6. Stack base

- Node.js 24 LTS
- TypeScript
- NestJS 12.x
- Prisma ORM 7.x
- PostgreSQL 18.6
- OpenAPI 3.1.2
- Protocol Buffers `proto3` + `@grpc/grpc-js`
- Buf
- Docker Compose v2
- Vitest
- k6 + Toxiproxy para el experimento de resiliencia

Fijar versiones exactas en el lockfile. No migrar versiones mayores durante el encargo sin una razón documentada.

## 7. Límites de cambio

Mantener los cambios enfocados al componente o responsabilidad necesaria:

- `/contracts`: contratos públicos/internos y configuración de validación.
- `/apps/sales-api`: implementación REST, persistencia de Sales y cliente gRPC.
- `/apps/inventory-grpc`: implementación gRPC, persistencia y motor de stock.
- `/tests/system`: pruebas de sistema black-box.
- `/experiments`: scripts y evidencia reproducible de experimentación.
- `/docs`: arquitectura, ADR y material del informe.

Evitar refactors oportunistas y cambios cruzados que no sean necesarios para el objetivo del PR.

## 8. Reglas Git

Usar una branch por cambio o issue, por ejemplo:

```text
feat/orders-grpc-integration
fix/inventory-stock-race
```

Un PR normal debe:

- tener un objetivo principal claro;
- incluir pruebas para comportamiento nuevo;
- evitar refactors no relacionados;
- mantener commits comprensibles;
- no modificar contratos congelados salvo que sea un PR dedicado de contrato.

No versionar código temporal de debugging, secretos, credenciales generadas, volúmenes locales de base de datos ni logs crudos que no formen parte de evidencia del experimento.

## 9. Disciplina de implementación

Antes de programar:

1. Leer este archivo.
2. Leer el contrato y documentos arquitectónicos relevantes.
3. Implementar la solución completa mínima que satisfaga el comportamiento congelado.
4. Añadir o ajustar pruebas automáticas.
5. Ejecutar lint, typecheck, tests, build y validaciones de contrato relevantes.
6. Revisar el diff para detectar drift de contrato o cambios no relacionados.

Preferir ingeniería simple y defendible. No introducir Kafka, Kubernetes, service mesh, transacciones distribuidas, retries automáticos gRPC, circuit breakers, Redis en la ruta de autorización de una orden ni estados públicos adicionales salvo que exista una decisión arquitectónica explícita que lo justifique.

## 10. Definition of Done

Un cambio de implementación está terminado cuando:

- el comportamiento coincide con OpenAPI/.proto;
- las pruebas relevantes pasan;
- ningún servicio accede a la base de otro;
- los fallos tienen semántica determinista y documentada;
- Docker/CI no se rompe;
- no se filtran secretos ni errores internos crudos;
- las decisiones no triviales pueden explicarse y defenderse.
