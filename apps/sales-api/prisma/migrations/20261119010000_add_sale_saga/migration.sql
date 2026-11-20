-- T2-301: estado persistente de la Saga de venta (orquestada por Sales).
-- Tablas internas de Sales: no hay foreign keys hacia otros servicios.

CREATE TYPE "sale_saga_status" AS ENUM ('RUNNING', 'COMPENSATING', 'COMPLETED', 'FAILED', 'CANCELLING', 'CANCELLED');
CREATE TYPE "sale_saga_step_status" AS ENUM ('SKIPPED', 'NOT_STARTED', 'IN_DOUBT', 'DONE', 'REJECTED', 'COMPENSATED');

CREATE TABLE "sale_sagas" (
  "order_id" UUID NOT NULL,
  "idempotency_key" VARCHAR(128) NOT NULL,
  "customer_id" UUID NOT NULL,
  "items" JSONB NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "status" "sale_saga_status" NOT NULL,
  "stock_status" "sale_saga_step_status" NOT NULL,
  "payment_status" "sale_saga_step_status" NOT NULL,
  "dispatch_status" "sale_saga_step_status" NOT NULL,
  "reservation" JSONB,
  "failure_status" INTEGER,
  "failure_code" VARCHAR(64),
  "failure_message" VARCHAR(200),
  "last_error_status" INTEGER,
  "last_error_code" VARCHAR(64),
  "last_error_message" VARCHAR(200),
  "compensation_attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMPTZ(3),
  "lease_owner" UUID,
  "lease_until" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "sale_sagas_pkey" PRIMARY KEY ("order_id"),
  CONSTRAINT "sale_sagas_amount_minor_check" CHECK ("amount_minor" > 0),
  CONSTRAINT "sale_sagas_idempotency_key_fkey" FOREIGN KEY ("idempotency_key") REFERENCES "idempotency_requests"("key") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "sale_sagas_idempotency_key_key" ON "sale_sagas"("idempotency_key");
CREATE INDEX "sale_sagas_status_next_attempt_at_idx" ON "sale_sagas"("status", "next_attempt_at");
CREATE INDEX "sale_sagas_status_updated_at_idx" ON "sale_sagas"("status", "updated_at");

-- Bitácora append-only de pasos y compensaciones: evidencia del orden inverso.
CREATE TABLE "sale_saga_events" (
  "id" BIGSERIAL NOT NULL,
  "order_id" UUID NOT NULL,
  "step" VARCHAR(16) NOT NULL,
  "action" VARCHAR(16) NOT NULL,
  "outcome" VARCHAR(16) NOT NULL,
  "code" VARCHAR(64),
  "trace_id" VARCHAR(128),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sale_saga_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sale_saga_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "sale_sagas"("order_id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "sale_saga_events_order_id_id_idx" ON "sale_saga_events"("order_id", "id");
