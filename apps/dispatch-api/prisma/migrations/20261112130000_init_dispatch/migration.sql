CREATE TYPE "dispatch_status" AS ENUM ('CREATED', 'CANCELLED');

CREATE TABLE "dispatches" (
    "order_id" UUID NOT NULL,
    "items" JSONB NOT NULL,
    "status" "dispatch_status" NOT NULL DEFAULT 'CREATED',

    CONSTRAINT "dispatches_pkey" PRIMARY KEY ("order_id")
);
