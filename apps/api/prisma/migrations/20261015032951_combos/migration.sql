-- AlterTable
ALTER TABLE "products" ADD COLUMN     "is_combo" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "combo_components" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "combo_product_id" UUID NOT NULL,
    "component_product_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "combo_components_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "combo_components_tenant_id_combo_product_id_idx" ON "combo_components"("tenant_id", "combo_product_id");

-- CreateIndex
CREATE UNIQUE INDEX "combo_components_combo_product_id_component_product_id_key" ON "combo_components"("combo_product_id", "component_product_id");

-- AddForeignKey
ALTER TABLE "combo_components" ADD CONSTRAINT "combo_components_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "combo_components" ADD CONSTRAINT "combo_components_combo_product_id_fkey" FOREIGN KEY ("combo_product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "combo_components" ADD CONSTRAINT "combo_components_component_product_id_fkey" FOREIGN KEY ("component_product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- Row-Level Security for the new tenant-owned table (same policy as every
-- previous phase).
-- ============================================================================
DO $$
BEGIN
  ALTER TABLE "combo_components" ENABLE ROW LEVEL SECURITY;
  ALTER TABLE "combo_components" FORCE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON "combo_components"
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
END $$;
