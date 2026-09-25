# Inventory gRPC

Servicio interno de RepuestosSur dueño del catálogo de piezas y del stock actual.
Implementa `repuestossur.inventory.v1.InventoryService` según el contrato congelado
[`contracts/grpc/repuestossur/inventory/v1/inventory.proto`](../../contracts/grpc/repuestossur/inventory/v1/inventory.proto).

| RPC | Estado |
|---|---|
| `GetPart` | implementado (RS-201) |
| `ListParts` | implementado (RS-201) |
| `ReserveStock` | pendiente (RS-202), hoy responde `UNIMPLEMENTED` |
| `ReleaseStock` | pendiente (RS-202), hoy responde `UNIMPLEMENTED` |

Stack: Node 24, TypeScript, NestJS 12 (ESM), Prisma 7 con `@prisma/adapter-pg`, PostgreSQL 18.6, Vitest.

## Estructura

```text
prisma/
  schema.prisma          modelo `parts` (base propia de Inventory)
  migrations/            migraciones SQL versionadas (incluye CHECK stock >= 0)
  seed-data.ts           catálogo inicial con UUID fijos
  seed-parts.ts          lógica del seed (insert-missing / reset)
  seed.ts                punto de entrada del seed
src/
  main.ts                arranque del microservicio gRPC
  app.module.ts          módulo raíz; recibe la configuración ya validada
  config/                lectura y validación de variables de entorno
  grpc/                  opciones del servidor, tipos del .proto, Timestamp, filtro de errores
  parts/                 GetPart / ListParts (controller, service, mapper)
  prisma/                PrismaService (una sola instancia y pool por proceso)
  common/                errores de dominio y validación de UUID
test/
  unit/                  sin base de datos
  integration/           PostgreSQL real + servidor gRPC real + cliente desde el .proto
```

## Variables de entorno

| Variable | Obligatoria | Por defecto | Descripción |
|---|---|---|---|
| `DATABASE_URL` | sí | - | PostgreSQL **propio** de Inventory |
| `GRPC_HOST` | no | `0.0.0.0` | interfaz de escucha |
| `GRPC_PORT` | no | `50051` | puerto gRPC |
| `INVENTORY_PROTO_PATH` | no | `../../contracts/grpc/repuestossur/inventory/v1/inventory.proto` | ruta al contrato, relativa al directorio del servicio |
| `SEED_ON_START` | no | `true` (sólo en Docker) | cargar las piezas faltantes al arrancar el contenedor |
| `TEST_DATABASE_URL` | sólo pruebas de integración | - | base desechable; su nombre debe contener `test` |

Ver [`.env.example`](.env.example).

## Desarrollo local

```bash
cd apps/inventory-grpc
cp .env.example .env

# PostgreSQL 18.6 local con una base de desarrollo y otra de pruebas
docker run -d --name rs-inventory-db-dev -p 55432:5432 \
  -e POSTGRES_USER=inventory -e POSTGRES_PASSWORD=inventory -e POSTGRES_DB=inventory \
  postgres:18.6
docker exec rs-inventory-db-dev psql -U inventory -c "CREATE DATABASE inventory_test"

npm ci
npm run build          # prisma generate + tsc
npm run db:migrate     # aplica prisma/migrations
npm run db:seed        # inserta las piezas que falten
npm start              # escucha en GRPC_PORT
```

## Pruebas

```bash
npm run typecheck
npm test                    # unitarias, sin base de datos
npm run test:integration    # requiere TEST_DATABASE_URL; aplica migraciones y borra la tabla parts
```

## Seed

El catálogo tiene 22 piezas con UUID y SKU fijos, así Sales, las pruebas de sistema,
la demo y el experimento usan los mismos identificadores en cualquier máquina.

- `npm run db:seed` inserta sólo las piezas que faltan. Es seguro repetirlo y nunca
  pisa el stock que cambió por ventas.
- `npm run db:seed -- --reset` además devuelve sku, nombre y stock de las piezas
  sembradas a sus valores iniciales.

Piezas con uso especial:

| Uso | SKU | UUID | Stock |
|---|---|---|---|
| demo de stock insuficiente | `EMB-KIT-020` | `74199389-6b4e-43f2-96b2-c2a4ab3959bc` | 0 |
| demo de stock insuficiente | `ESC-SIL-021` | `f989e963-a0fb-4799-80e8-1aeff10629be` | 0 |
| stock bajo | `ELE-ALT-018` | `5bb2c044-90eb-4e4c-83ec-2815f25d3b0b` | 1 |
| experimento RS-402 (`EXPERIMENT_PART_ID`) | `EXP-TIMEOUT-000` | `0be383fa-f9d8-4eb9-87ec-2e528faf83eb` | 50000 |

## Errores gRPC

Traducidos en un solo lugar, [`src/grpc/grpc-error.filter.ts`](src/grpc/grpc-error.filter.ts),
según [ERROR-MAPPING.md](../../docs/architecture/ERROR-MAPPING.md):

| Condición | Estado |
|---|---|
| `part_id` no es un UUID | `INVALID_ARGUMENT` |
| pieza inexistente | `NOT_FOUND` |
| cualquier error inesperado (BD, bug) | `INTERNAL` con mensaje genérico; el detalle sólo va al log |

## Docker

El contexto de build es la raíz del repo, porque la imagen incluye `contracts/grpc`:

```bash
docker build -f apps/inventory-grpc/Dockerfile -t repuestossur/inventory-grpc .
docker run --rm -p 50051:50051 \
  -e DATABASE_URL=postgresql://inventory:inventory@host.docker.internal:55432/inventory \
  repuestossur/inventory-grpc
```

Al arrancar, el contenedor aplica las migraciones pendientes (`prisma migrate deploy`), carga
las piezas faltantes y queda escuchando. `docker stop` cierra el servidor y el pool de
conexiones de forma ordenada.
