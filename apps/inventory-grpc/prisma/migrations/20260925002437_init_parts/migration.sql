-- CreateTable
CREATE TABLE "parts" (
    "id" UUID NOT NULL,
    "sku" VARCHAR(40) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "stock_available" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "parts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "parts_sku_key" ON "parts"("sku");

-- Agregado a mano: invariante "el stock nunca puede ser negativo"
-- (DATA-OWNERSHIP.md). La base lo garantiza aunque falle la validación
-- de la aplicación.
ALTER TABLE "parts" ADD CONSTRAINT "parts_stock_available_non_negative" CHECK ("stock_available" >= 0);
