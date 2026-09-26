# RepuestosSur

[![CI](https://github.com/ba-hc/tarea-integracion-sistemas/actions/workflows/ci.yml/badge.svg)](https://github.com/ba-hc/tarea-integracion-sistemas/actions/workflows/ci.yml)

Proyecto de la Unidad 1 de **Integración de Sistemas** (Ingeniería Informática, Universidad de Concepción) para el dominio **Forma D: Sistema de Gestión de Tienda de Repuestos**.

El objetivo es integrar dos sistemas independientes:

- **Sales API**: API REST pública para clientes y órdenes de venta.
- **Inventory Service**: servicio gRPC interno responsable de piezas y stock.

Una orden sólo se confirma cuando Inventario reserva de forma atómica el stock solicitado. Cada servicio mantiene su propia base de datos PostgreSQL y el sistema completo puede levantarse con Docker Compose.

## Integrantes y responsabilidades

| Integrante | GitHub | Responsabilidad principal |
|---|---|---|
| Benjamín Henríquez | [`@ba-hc`](https://github.com/ba-hc) | Sales REST, integración gRPC, resiliencia e idempotencia pública |
| Martín Fuentealba Bizama | [`@martin777pro`](https://github.com/martin777pro) | Inventory gRPC, persistencia y motor transaccional de stock |
| Jorge Slimming | [`@JorshSlimming`](https://github.com/JorshSlimming) | contratos, plataforma local, Docker Compose y CI/quality gates |
| Tomás Gutiérrez | [`@TomasGutierrez777`](https://github.com/TomasGutierrez777) | pruebas black-box, experimento ABET 6 y evidencia técnica |

La trazabilidad detallada del trabajo se conserva en los issues, PRs y commits del repositorio.

## Funcionalidades implementadas

- API REST pública versionada bajo `/v1` para clientes y órdenes.
- Servicio Inventory gRPC con `GetPart`, `ListParts`, `ReserveStock` y `ReleaseStock`.
- Reserva atómica de stock antes de confirmar una orden y reposición al cancelar.
- Base de datos PostgreSQL independiente por servicio, sin acceso cruzado.
- Autenticación mediante `X-API-Key` con roles `reader` y `operator`.
- Contratos explícitos y versionados mediante OpenAPI y Protocol Buffers.
- Deadline gRPC de 800 ms y traducción de fallas a HTTP 503/504.
- Idempotencia de creación de órdenes mediante `Idempotency-Key`.
- Pruebas unitarias, integración PostgreSQL, black-box y modos de falla.
- Experimento reproducible con k6 + Toxiproxy para medir el efecto del timeout.
- CI automático para contratos, builds y pruebas del sistema.

## Arquitectura

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

## Documentación de referencia

Las principales fuentes de diseño y contrato del proyecto son:

1. [OpenAPI REST v1](contracts/rest/openapi.yaml)
2. [Contrato gRPC v1](contracts/grpc/repuestossur/inventory/v1/inventory.proto)
3. [Architecture Decision Records](docs/adr/)
4. [Diseño del sistema](docs/architecture/SYSTEM-DESIGN.md)
5. [Propiedad de datos](docs/architecture/DATA-OWNERSHIP.md)
6. [Autenticación y autorización](docs/architecture/AUTH.md)
7. [Resiliencia](docs/architecture/RELIABILITY.md)
8. [Mapeo de errores](docs/architecture/ERROR-MAPPING.md)
9. [Congelamiento de contratos](docs/architecture/CONTRACT-FREEZE.md)
10. [Matriz de aceptación](docs/architecture/TEST-MATRIX.md)

[`AGENTS.md`](AGENTS.md) y [`CONTRIBUTING.md`](CONTRIBUTING.md) contienen reglas operativas para desarrollo y contribuciones.

Si una implementación contradice un contrato o una decisión arquitectónica aceptada, prevalece la fuente de contrato/ADR hasta que exista un cambio deliberado y documentado.

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

Requisito principal: Docker con Docker Compose v2. Node.js 24 sólo es necesario para ejecutar herramientas o pruebas directamente fuera de los contenedores.

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

## Verificación automática

El workflow [`.github/workflows/ci.yml`](.github/workflows/ci.yml) se ejecuta en pull requests y pushes a `main` y valida:

- OpenAPI con Redocly y compatibilidad con oasdiff.
- Protobuf con `buf lint` y `buf breaking`.
- Configuración de Docker Compose.
- Typecheck, pruebas unitarias, integración PostgreSQL y build de Inventory.
- Typecheck, pruebas unitarias, integración PostgreSQL y build de Sales.
- Pruebas black-box del sistema integrado.
- Pruebas de falla de dependencia mediante Toxiproxy.

## Uso de asistentes de IA

Durante el desarrollo y la revisión del proyecto se utilizaron **ChatGPT y OpenAI Codex** como asistentes para análisis arquitectónico, revisión de contratos, documentación técnica, configuración de CI, diseño y revisión de pruebas, y validación de decisiones de integración y resiliencia.

El uso de estos asistentes fue complementario al trabajo del equipo: las decisiones de arquitectura, contratos, implementación y resultados experimentales fueron revisados y contrastados con el código, los ADR, los contratos versionados y las pruebas automatizadas del repositorio.

La verificación final incluyó `actionlint`, Redocly y oasdiff para OpenAPI, `buf lint` y `buf breaking` para Protocol Buffers, `docker compose config`, typecheck, pruebas unitarias, pruebas de integración PostgreSQL y build de ambas aplicaciones, además de las pruebas black-box y de resiliencia del sistema. También se verificó el arranque mediante Docker Compose con y sin el perfil de experimentación. Oasdiff no detectó cambios contractuales incompatibles respecto de la línea base congelada.
