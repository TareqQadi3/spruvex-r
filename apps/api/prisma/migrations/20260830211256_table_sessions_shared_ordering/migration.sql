-- AlterTable
ALTER TABLE "loyalty_customers" ALTER COLUMN "tenant_id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "loyalty_ledger_entries" ALTER COLUMN "tenant_id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "loyalty_program_configs" ALTER COLUMN "tenant_id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "participant_phone" TEXT,
ADD COLUMN     "refunded_quantity" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "table_sessions" ADD COLUMN     "last_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "stale_flagged_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "table_session_participants" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "table_session_id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "table_session_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_append_logs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_append_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "table_session_participants_table_session_id_phone_key" ON "table_session_participants"("table_session_id", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "order_append_logs_tenant_id_idempotency_key_key" ON "order_append_logs"("tenant_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "table_session_participants" ADD CONSTRAINT "table_session_participants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_session_participants" ADD CONSTRAINT "table_session_participants_table_session_id_fkey" FOREIGN KEY ("table_session_id") REFERENCES "table_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_append_logs" ADD CONSTRAINT "order_append_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_append_logs" ADD CONSTRAINT "order_append_logs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- Row-Level Security for the new tenant-owned tables (same policy as every
-- previous phase).
-- ============================================================================
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['table_session_participants', 'order_append_logs']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = NULLIF(current_setting(''app.current_tenant_id'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.current_tenant_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END
$$;

-- ============================================================================
-- At most one OPEN session per table. A plain (non-partial) unique index on
-- table_id would forbid ever reopening a table after it closes, so this is a
-- partial index — the exact tool for "unique among open rows only" — which
-- Prisma's schema language cannot express, hence the hand-written SQL. This
-- is what makes two phones scanning the same table's QR at the same instant
-- resolve to ONE session instead of silently creating two: the loser of the
-- race gets a unique-violation and re-reads the winner's session instead
-- (see TableSessionsService.findOrOpenSession).
-- ============================================================================
CREATE UNIQUE INDEX "table_sessions_one_open_per_table" ON "table_sessions"("table_id") WHERE "closed_at" IS NULL;
