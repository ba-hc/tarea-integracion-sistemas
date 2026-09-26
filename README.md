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

Las versiones exactas de dependencias de aplicación quedan fijadas en los lockfiles de cada servicio.

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
- Tag publicado: `contracts-v1.0.0`

Después de congelar esa línea base, los cambios a `openapi.yaml` o `inventory.proto` deben realizarse mediante un cambio de contrato deliberado, no como efecto colateral de una implementación.

## Decisiones de arquitectura

- `ADR-001`: límites entre Sales e Inventory.
- `ADR-002`: REST hacia afuera y gRPC hacia adentro.
- `ADR-003`: versionado y evolución de contratos.
- `ADR-004`: resiliencia y modos de falla.

## Ejecución local

Node.js 24 y Docker Compose v2 son necesarios.

```bash
docker compose up --build
```

Copiar `.env.example` a `.env` es opcional; Compose ya define valores locales por defecto. Use ese archivo si necesita sobreescribirlos.

Sales queda disponible en `http://localhost:3000`; `/v1/health` es público. Las claves
locales están declaradas en `.env.example` sólo para la demo. Sustitúyelas antes de usar
el sistema fuera de una máquina de desarrollo. La API, autenticación y errores se describen
en [OpenAPI](contracts/rest/openapi.yaml); la base de datos de Sales es independiente de
Inventory.

Compose monta PostgreSQL 18 en `/var/lib/postgresql` y usa volúmenes versionados
(`sales-data-v18`, `inventory-data-v18`). Los volúmenes antiguos `sales-data` e
`inventory-data` se conservan sin montarse; Compose no migra automáticamente bases de datos
anteriores. Haz backup y una migración explícita antes de reutilizar datos existentes.

La suite HTTP black-box está en [`tests/system`](tests/system/README.md). Pruebas unitarias
y la integración PostgreSQL de Sales se ejecutan desde `apps/sales-api`; el método, los
resultados de resiliencia y el guion de demostración están en [`experiments/timeout`](experiments/timeout/README.md)
y [`docs/report/DEMO.md`](docs/report/DEMO.md).

## Uso de asistentes de IA

Durante el desarrollo y la revisión del proyecto se utilizaron **ChatGPT y OpenAI Codex** como asistentes para análisis arquitectónico, revisión de contratos, documentación técnica, configuración de CI, diseño y revisión de pruebas, y validación de decisiones de integración y resiliencia.

El uso de estos asistentes fue complementario al trabajo del equipo: las decisiones de arquitectura, contratos, implementación y resultados experimentales fueron revisados y contrastados con el código, los ADR, los contratos versionados y las pruebas automatizadas del repositorio.

La verificación final incluyó `actionlint`, Redocly y oasdiff para OpenAPI, `buf lint` y `buf breaking` para Protocol Buffers, `docker compose config`, typecheck, pruebas unitarias, pruebas de integración PostgreSQL y build de ambas aplicaciones, además de las pruebas black-box y de resiliencia del sistema. También se verificó el arranque mediante Docker Compose con y sin el perfil de experimentación. Oasdiff no detectó cambios contractuales incompatibles respecto de la línea base congelada.
