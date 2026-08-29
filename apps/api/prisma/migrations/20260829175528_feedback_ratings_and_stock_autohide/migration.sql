-- AlterTable
ALTER TABLE "delivery_product_mappings" ALTER COLUMN "tenant_id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "integration_connections" ALTER COLUMN "tenant_id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "recipe_items" ADD COLUMN     "critical_threshold" DECIMAL(14,3),
ADD COLUMN     "is_critical" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "whatsapp_template_overrides" ALTER COLUMN "tenant_id" DROP DEFAULT;

-- CreateTable
CREATE TABLE "product_stock_hides" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "ingredient_id" UUID NOT NULL,
    "hidden_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_stock_hides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_feedback_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "primary_product_id" UUID,
    "send_after" TIMESTAMP(3) NOT NULL,
    "sent_at" TIMESTAMP(3),
    "rating" SMALLINT,
    "comment" TEXT,
    "rated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_feedback_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_stock_hides_tenant_id_branch_id_idx" ON "product_stock_hides"("tenant_id", "branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_stock_hides_product_id_branch_id_key" ON "product_stock_hides"("product_id", "branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_feedback_requests_order_id_key" ON "order_feedback_requests"("order_id");

-- CreateIndex
CREATE INDEX "order_feedback_requests_tenant_id_branch_id_rated_at_idx" ON "order_feedback_requests"("tenant_id", "branch_id", "rated_at");

-- CreateIndex
CREATE INDEX "order_feedback_requests_send_after_sent_at_idx" ON "order_feedback_requests"("send_after", "sent_at");

-- AddForeignKey
ALTER TABLE "product_stock_hides" ADD CONSTRAINT "product_stock_hides_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_stock_hides" ADD CONSTRAINT "product_stock_hides_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_stock_hides" ADD CONSTRAINT "product_stock_hides_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_stock_hides" ADD CONSTRAINT "product_stock_hides_ingredient_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "ingredients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_feedback_requests" ADD CONSTRAINT "order_feedback_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_feedback_requests" ADD CONSTRAINT "order_feedback_requests_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_feedback_requests" ADD CONSTRAINT "order_feedback_requests_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_feedback_requests" ADD CONSTRAINT "order_feedback_requests_primary_product_id_fkey" FOREIGN KEY ("primary_product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- Row-Level Security for the new tenant-owned tables (same policy as every
-- previous phase).
-- ============================================================================
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['product_stock_hides', 'order_feedback_requests']
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
