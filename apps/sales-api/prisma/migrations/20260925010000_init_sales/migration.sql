CREATE TYPE "order_status" AS ENUM ('CONFIRMED', 'CANCELLED');
CREATE TYPE "idempotency_state" AS ENUM ('IN_PROGRESS', 'CONFIRMED', 'FAILED');

CREATE TABLE "customers" (
  "id" UUID NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "email" VARCHAR(254) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "customers_email_key" ON "customers"("email");

CREATE TABLE "orders" (
  "id" UUID NOT NULL,
  "customer_id" UUID NOT NULL,
  "status" "order_status" NOT NULL DEFAULT 'CONFIRMED',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  "cancelled_at" TIMESTAMPTZ(3),
  CONSTRAINT "orders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "orders_customer_id_created_at_idx" ON "orders"("customer_id", "created_at");
CREATE INDEX "orders_status_created_at_idx" ON "orders"("status", "created_at");

CREATE TABLE "order_items" (
  "id" UUID NOT NULL,
  "order_id" UUID NOT NULL,
  "part_id" UUID NOT NULL,
  "part_sku_snapshot" VARCHAR(40) NOT NULL,
  "part_name_snapshot" VARCHAR(120) NOT NULL,
  "quantity" INTEGER NOT NULL,
  CONSTRAINT "order_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "order_items_quantity_check" CHECK ("quantity" BETWEEN 1 AND 999)
);
CREATE UNIQUE INDEX "order_items_order_id_part_id_key" ON "order_items"("order_id", "part_id");
CREATE INDEX "order_items_part_id_idx" ON "order_items"("part_id");

CREATE TABLE "idempotency_requests" (
  "key" VARCHAR(128) NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "order_id" UUID NOT NULL,
  "state" "idempotency_state" NOT NULL,
  "response_status" INTEGER,
  "response_body" JSONB,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "idempotency_requests_pkey" PRIMARY KEY ("key"),
  CONSTRAINT "idempotency_requests_order_id_key" UNIQUE ("order_id")
);
