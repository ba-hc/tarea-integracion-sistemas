# RepuestosSur

Proyecto de la Unidad 1 de **Integración de Sistemas** (Ingeniería Informática, Universidad de Concepción) para el dominio **Forma D: Sistema de Gestión de Tienda de Repuestos**.

El objetivo es integrar dos sistemas independientes:

- **Sales API**: API REST pública para clientes y órdenes de venta.
- **Inventory Service**: servicio gRPC interno responsable de piezas y stock.

Una orden sólo se confirma cuando Inventario reserva de forma atómica el stock solicitado. Cada servicio mantiene su propia base de datos PostgreSQL y el sistema completo debe poder levantarse con Docker Compose.

## Arquitectura base

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

## Stack acordado

- Node.js 24 LTS
- TypeScript
- NestJS 12.x
- Prisma ORM 7.x
- PostgreSQL 18.6
- OpenAPI 3.1.2
- Protocol Buffers `proto3` + gRPC
- Buf
- Docker Compose v2
- Vitest
- k6 + Toxiproxy para experimentación de resiliencia

Las versiones exactas de dependencias de aplicación deben quedar fijadas por el lockfile cuando se inicialicen los servicios.

## Fuentes autoritativas

Antes de implementar, revisar en este orden:

1. [`AGENTS.md`](AGENTS.md)
2. [`docs/architecture/SYSTEM-DESIGN.md`](docs/architecture/SYSTEM-DESIGN.md)
3. [`contracts/rest/openapi.yaml`](contracts/rest/openapi.yaml)
4. [`contracts/grpc/repuestossur/inventory/v1/inventory.proto`](contracts/grpc/repuestossur/inventory/v1/inventory.proto)
5. [`docs/adr/`](docs/adr/)
6. [`docs/architecture/CONTRACT-FREEZE.md`](docs/architecture/CONTRACT-FREEZE.md)
7. [`docs/architecture/TEST-MATRIX.md`](docs/architecture/TEST-MATRIX.md)

Si una implementación contradice el contrato o una decisión arquitectónica aceptada, prevalece el contrato/ADR hasta que exista un cambio explícitamente aprobado.

## Contratos

La línea base de integración corresponde a:

- REST: `/v1`
- gRPC package: `repuestossur.inventory.v1`
- Tag previsto: `contracts-v1.0.0`

Después de congelar esa línea base, los cambios a `openapi.yaml` o `inventory.proto` deben realizarse mediante un cambio de contrato deliberado, no como efecto colateral de una implementación.

## Decisiones de arquitectura

- `ADR-001`: límites entre Sales e Inventory.
- `ADR-002`: REST hacia afuera y gRPC hacia adentro.
- `ADR-003`: versionado y evolución de contratos.
- `ADR-004`: resiliencia y modos de falla.

## Estado actual

Este repositorio comienza con los contratos y decisiones de arquitectura preparados para que la implementación pueda avanzar sin redefinir interfaces durante el desarrollo.

## Uso de asistentes de IA

El proyecto puede utilizar asistentes de IA como apoyo para análisis, documentación, generación de borradores de código y revisión. Todo contenido incorporado al repositorio debe ser revisado, probado y comprendido por quienes lo presenten. Esta sección se actualizará antes de la entrega final con las herramientas efectivamente utilizadas, su propósito y las verificaciones realizadas.
