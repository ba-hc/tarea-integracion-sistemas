# Inventory gRPC

Servicio interno de RepuestosSur dueño del catálogo de piezas y del stock actual.
Implementa `repuestossur.inventory.v1.InventoryService` según el contrato congelado
[`contracts/grpc/repuestossur/inventory/v1/inventory.proto`](../../contracts/grpc/repuestossur/inventory/v1/inventory.proto).

| RPC | Estado |
|---|---|
| `GetPart` | implementado (RS-201) |
| `ListParts` | implementado (RS-201) |
| `ReserveStock` | implementado (RS-202) |
| `ReleaseStock` | implementado (RS-202) |

Stack: Node 24, TypeScript, NestJS 12 (ESM), Prisma 7 con `@prisma/adapter-pg`, PostgreSQL 18.6, Vitest.

## Estructura

```text
prisma/
  schema.prisma          `parts` y el ledger `stock_operations` / `stock_operation_items`
  migrations/            migraciones SQL versionadas (incluye los CHECK de invariantes)
  seed-data.ts           catálogo inicial con UUID fijos
  seed-parts.ts          lógica del seed (insert-missing / reset)
  seed.ts                punto de entrada del seed
src/
  main.ts                arranque del microservicio gRPC
  app.module.ts          módulo raíz; recibe la configuración ya validada
  config/                lectura y validación de variables de entorno
  grpc/                  opciones del servidor, tipos del .proto, Timestamp, filtro de errores
  parts/                 GetPart / ListParts (controller, service, mapper)
  stock/                 ReserveStock / ReleaseStock (validación, huella, transacción, mapper)
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
npm run test:integration    # requiere TEST_DATABASE_URL; aplica migraciones y vacía las tablas
```

`test/integration/grpc-stock-concurrency.spec.ts` contiene el caso obligatorio de
[TEST-MATRIX.md](../../docs/architecture/TEST-MATRIX.md): stock 10 y 20 reservas
simultáneas de 1 unidad dan exactamente 10 éxitos, 10 `FAILED_PRECONDITION` y stock final 0.

## Reserva y liberación de stock

Cada `ReserveStock` / `ReleaseStock` corre en **una transacción** de PostgreSQL (READ COMMITTED):

1. `pg_advisory_xact_lock(order_id)` serializa las llamadas con el mismo `order_id`, así un
   duplicado simultáneo espera y devuelve el replay en vez de chocar.
2. Si ya existe una operación para ese `order_id`, se responde desde el ledger (`replayed=true`)
   sin tocar el stock. En `ReserveStock`, si la huella de los ítems difiere, responde `ALREADY_EXISTS`.
3. `SELECT … FROM parts … ORDER BY id FOR UPDATE` bloquea las piezas involucradas. Ordenar por
   id hace que dos órdenes con piezas en común pidan los bloqueos en el mismo orden (sin deadlocks).
4. Se valida todo (piezas existentes, stock suficiente) **antes** de la primera escritura; si algo
   falla, no se escribió nada. Luego se descuentan o reponen todas las piezas y se registra el ledger.

El `CHECK (stock_available >= 0)` de la base es la última defensa si la aplicación fallara.

**Ledger.** `stock_operations` tiene una fila por `order_id` (estado `RESERVED` → `RELEASED`, huella
sha256 de los ítems normalizados y timestamps). `stock_operation_items` guarda por línea la cantidad,
el stock antes/después de la reserva y de la liberación, y la foto de sku/nombre, lo que permite
reproducir exactamente cualquier respuesta. Una reserva fallida no deja rastro ni consume el
`order_id`: puede reintentarse cuando haya stock.

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
| UUID mal formado, `items` vacío o con más de 50, cantidad fuera de 1..999, pieza duplicada | `INVALID_ARGUMENT` |
| pieza inexistente (`GetPart` o alguna línea de `ReserveStock`) | `NOT_FOUND` |
| stock insuficiente en alguna línea | `FAILED_PRECONDITION` |
| mismo `order_id` con otro payload de reserva | `ALREADY_EXISTS` |
| cualquier error inesperado (BD, bug) | `INTERNAL` con mensaje genérico; el detalle sólo va al log |

**Provisorio** (ERROR-MAPPING.md no define estos casos; pendiente de acordar con Sales):

| Condición | Estado actual |
|---|---|
| `ReleaseStock` de un `order_id` sin reserva | `NOT_FOUND` |
| `ReserveStock` de un `order_id` ya liberado (mismo payload) | `FAILED_PRECONDITION`, sin mutar stock |

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
