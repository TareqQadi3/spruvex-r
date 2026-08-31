-- CreateTable
CREATE TABLE "ingredient_reorder_alerts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "ingredient_id" UUID NOT NULL,
    "alerted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingredient_reorder_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ingredient_reorder_alerts_tenant_id_branch_id_idx" ON "ingredient_reorder_alerts"("tenant_id", "branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "ingredient_reorder_alerts_branch_id_ingredient_id_key" ON "ingredient_reorder_alerts"("branch_id", "ingredient_id");

-- AddForeignKey
ALTER TABLE "ingredient_reorder_alerts" ADD CONSTRAINT "ingredient_reorder_alerts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingredient_reorder_alerts" ADD CONSTRAINT "ingredient_reorder_alerts_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingredient_reorder_alerts" ADD CONSTRAINT "ingredient_reorder_alerts_ingredient_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "ingredients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- Row-Level Security for the new tenant-owned table (same policy as every
-- previous phase).
-- ============================================================================
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ingredient_reorder_alerts']
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
END $$;
