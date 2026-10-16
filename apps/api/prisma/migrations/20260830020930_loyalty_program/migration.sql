-- CreateEnum
CREATE TYPE "loyalty_program_type" AS ENUM ('stamp_card', 'spend_threshold', 'points_per_riyal', 'tier');

-- CreateEnum
CREATE TYPE "loyalty_ledger_type" AS ENUM ('stamp_earned', 'stamp_redeemed', 'stamp_reversed', 'spend_accrued', 'spend_redeemed', 'spend_reversed', 'points_earned', 'points_redeemed', 'points_reversed', 'tier_changed');

-- AlterTable
ALTER TABLE "order_feedback_requests" ALTER COLUMN "tenant_id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "product_stock_hides" ALTER COLUMN "tenant_id" DROP DEFAULT;

-- CreateTable
CREATE TABLE "loyalty_program_configs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID,
    "type" "loyalty_program_type" NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "loyalty_program_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loyalty_customers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT,
    "stamp_count" INTEGER NOT NULL DEFAULT 0,
    "spend_accumulated" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "spend_period_start" TIMESTAMP(3),
    "points_balance" INTEGER NOT NULL DEFAULT 0,
    "lifetime_spend" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "tier_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loyalty_customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loyalty_ledger_entries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "order_id" UUID,
    "type" "loyalty_ledger_type" NOT NULL,
    "amount" DECIMAL(12,3) NOT NULL,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "performed_by" UUID,

    CONSTRAINT "loyalty_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "loyalty_program_configs_tenant_id_type_idx" ON "loyalty_program_configs"("tenant_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_program_configs_tenant_id_branch_id_type_key" ON "loyalty_program_configs"("tenant_id", "branch_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_customers_tenant_id_phone_key" ON "loyalty_customers"("tenant_id", "phone");

-- CreateIndex
CREATE INDEX "loyalty_ledger_entries_tenant_id_customer_id_created_at_idx" ON "loyalty_ledger_entries"("tenant_id", "customer_id", "created_at");

-- CreateIndex
CREATE INDEX "loyalty_ledger_entries_tenant_id_order_id_idx" ON "loyalty_ledger_entries"("tenant_id", "order_id");

-- AddForeignKey
ALTER TABLE "loyalty_program_configs" ADD CONSTRAINT "loyalty_program_configs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_program_configs" ADD CONSTRAINT "loyalty_program_configs_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_customers" ADD CONSTRAINT "loyalty_customers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_ledger_entries" ADD CONSTRAINT "loyalty_ledger_entries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_ledger_entries" ADD CONSTRAINT "loyalty_ledger_entries_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_ledger_entries" ADD CONSTRAINT "loyalty_ledger_entries_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "loyalty_customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_ledger_entries" ADD CONSTRAINT "loyalty_ledger_entries_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- Row-Level Security for the new tenant-owned tables (same policy as every
-- previous phase).
-- ============================================================================
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['loyalty_program_configs', 'loyalty_customers', 'loyalty_ledger_entries']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = NULLIF(current_setting(''app.current_tenant_id'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.current_tenant_id'', true), '''')::uuid)',
      t
    );
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN tenant_id SET DEFAULT NULLIF(current_setting(''app.current_tenant_id'', true), '''')::uuid',
      t
    );
  END LOOP;
END
$$;
