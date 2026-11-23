-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('PENDING', 'CHARGED', 'DECLINED', 'REFUND_PENDING', 'REFUNDED');

-- CreateEnum
CREATE TYPE "refund_outcome" AS ENUM ('REFUNDED', 'VOIDED');

-- CreateTable
CREATE TABLE "payments" (
    "order_id" UUID NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "payment_status" NOT NULL DEFAULT 'PENDING',
    "gateway_attempts" INTEGER NOT NULL DEFAULT 0,
    "gateway_charge_id" TEXT,
    "refund_outcome" "refund_outcome",
    "last_error_code" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("order_id"),
    CONSTRAINT "payments_amount_minor_positive" CHECK ("amount_minor" > 0),
    CONSTRAINT "payments_currency_iso4217" CHECK ("currency" ~ '^[A-Z]{3}$'),
    CONSTRAINT "payments_gateway_attempts_non_negative" CHECK ("gateway_attempts" >= 0),
    CONSTRAINT "payments_refund_outcome_only_when_refunded" CHECK (("refund_outcome" IS NULL) OR ("status" = 'REFUNDED'))
);

-- CreateIndex
CREATE INDEX "payments_status_updated_at_idx" ON "payments"("status", "updated_at");
