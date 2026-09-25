-- CreateEnum
CREATE TYPE "stock_operation_status" AS ENUM ('RESERVED', 'RELEASED');

-- CreateTable
CREATE TABLE "stock_operations" (
    "order_id" UUID NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "status" "stock_operation_status" NOT NULL,
    "reserved_at" TIMESTAMPTZ(3) NOT NULL,
    "released_at" TIMESTAMPTZ(3),

    CONSTRAINT "stock_operations_pkey" PRIMARY KEY ("order_id")
);

-- CreateTable
CREATE TABLE "stock_operation_items" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "line_number" SMALLINT NOT NULL,
    "part_id" UUID NOT NULL,
    "part_sku" VARCHAR(40) NOT NULL,
    "part_name" VARCHAR(120) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "reserved_stock_before" INTEGER NOT NULL,
    "reserved_stock_after" INTEGER NOT NULL,
    "released_stock_before" INTEGER,
    "released_stock_after" INTEGER,

    CONSTRAINT "stock_operation_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_operation_items_part_id_idx" ON "stock_operation_items"("part_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_operation_items_order_id_part_id_key" ON "stock_operation_items"("order_id", "part_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_operation_items_order_id_line_number_key" ON "stock_operation_items"("order_id", "line_number");

-- AddForeignKey
ALTER TABLE "stock_operation_items" ADD CONSTRAINT "stock_operation_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "stock_operations"("order_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_operation_items" ADD CONSTRAINT "stock_operation_items_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "parts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Agregado a mano: invariantes que Prisma no expresa en el esquema.
-- Cantidad por línea entre 1 y 999 (SYSTEM-DESIGN.md) y línea entre 1 y 50.
ALTER TABLE "stock_operation_items" ADD CONSTRAINT "stock_operation_items_quantity_range" CHECK ("quantity" BETWEEN 1 AND 999);
ALTER TABLE "stock_operation_items" ADD CONSTRAINT "stock_operation_items_line_number_range" CHECK ("line_number" BETWEEN 1 AND 50);
-- El ledger nunca registra stock negativo y es aritméticamente coherente.
ALTER TABLE "stock_operation_items" ADD CONSTRAINT "stock_operation_items_reserve_arithmetic"
  CHECK ("reserved_stock_after" >= 0 AND "reserved_stock_after" = "reserved_stock_before" - "quantity");
ALTER TABLE "stock_operation_items" ADD CONSTRAINT "stock_operation_items_release_arithmetic"
  CHECK (
    ("released_stock_before" IS NULL AND "released_stock_after" IS NULL)
    OR ("released_stock_before" >= 0 AND "released_stock_after" = "released_stock_before" + "quantity")
  );
-- released_at existe si y sólo si la operación fue liberada.
ALTER TABLE "stock_operations" ADD CONSTRAINT "stock_operations_released_at_matches_status"
  CHECK (("status" = 'RELEASED') = ("released_at" IS NOT NULL));
