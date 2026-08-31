-- CreateEnum
CREATE TYPE "purchase_invoice_reversal_type" AS ENUM ('cancellation', 'supplier_credit_note');

-- AlterEnum
ALTER TYPE "stock_movement_type" ADD VALUE 'purchase_reversal';

-- CreateTable
CREATE TABLE "purchase_invoice_reversals" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "purchase_invoice_id" UUID NOT NULL,
    "reversal_type" "purchase_invoice_reversal_type" NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "purchase_invoice_reversals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_invoice_reversal_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "reversal_id" UUID NOT NULL,
    "purchase_invoice_item_id" UUID NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_invoice_reversal_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "purchase_invoice_reversals_tenant_id_purchase_invoice_id_idx" ON "purchase_invoice_reversals"("tenant_id", "purchase_invoice_id");

-- CreateIndex
CREATE INDEX "purchase_invoice_reversal_items_tenant_id_reversal_id_idx" ON "purchase_invoice_reversal_items"("tenant_id", "reversal_id");

-- CreateIndex
CREATE INDEX "purchase_invoice_reversal_items_tenant_id_purchase_invoice__idx" ON "purchase_invoice_reversal_items"("tenant_id", "purchase_invoice_item_id");

-- AddForeignKey
ALTER TABLE "purchase_invoice_reversals" ADD CONSTRAINT "purchase_invoice_reversals_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_invoice_reversals" ADD CONSTRAINT "purchase_invoice_reversals_purchase_invoice_id_fkey" FOREIGN KEY ("purchase_invoice_id") REFERENCES "purchase_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_invoice_reversal_items" ADD CONSTRAINT "purchase_invoice_reversal_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_invoice_reversal_items" ADD CONSTRAINT "purchase_invoice_reversal_items_reversal_id_fkey" FOREIGN KEY ("reversal_id") REFERENCES "purchase_invoice_reversals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_invoice_reversal_items" ADD CONSTRAINT "purchase_invoice_reversal_items_purchase_invoice_item_id_fkey" FOREIGN KEY ("purchase_invoice_item_id") REFERENCES "purchase_invoice_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- Row-Level Security for the new tenant-owned tables (same policy as every
-- previous phase).
-- ============================================================================
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['purchase_invoice_reversals', 'purchase_invoice_reversal_items']
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
