-- CreateEnum
CREATE TYPE "integration_category" AS ENUM ('delivery_platform', 'payment_gateway', 'nfc_terminal', 'whatsapp');

-- AlterEnum
ALTER TYPE "payment_method" ADD VALUE 'online';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "payment_status" ADD VALUE 'pending';
ALTER TYPE "payment_status" ADD VALUE 'failed';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "delivery_commission" DECIMAL(12,2),
ADD COLUMN     "delivery_provider" TEXT,
ADD COLUMN     "external_order_id" TEXT;

-- CreateTable
CREATE TABLE "integration_connections" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID,
    "category" "integration_category" NOT NULL,
    "provider" TEXT NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT false,
    "environment" TEXT NOT NULL DEFAULT 'test',
    "config" JSONB NOT NULL DEFAULT '{}',
    "secret_enc" TEXT,
    "webhook_secret_enc" TEXT,
    "last_verified_at" TIMESTAMP(3),
    "last_synced_at" TIMESTAMP(3),
    "last_error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "integration_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_product_mappings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "external_item_id" TEXT NOT NULL,
    "external_item_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_product_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_template_overrides" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "template_key" TEXT NOT NULL,
    "custom_body_ar" TEXT,
    "approval_status" TEXT NOT NULL DEFAULT 'not_submitted',
    "meta_template_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_template_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "integration_connections_tenant_id_category_idx" ON "integration_connections"("tenant_id", "category");

-- CreateIndex
CREATE UNIQUE INDEX "integration_connections_tenant_id_branch_id_category_provid_key" ON "integration_connections"("tenant_id", "branch_id", "category", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_product_mappings_connection_id_external_item_id_key" ON "delivery_product_mappings"("connection_id", "external_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_product_mappings_connection_id_product_id_key" ON "delivery_product_mappings"("connection_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_template_overrides_tenant_id_template_key_key" ON "whatsapp_template_overrides"("tenant_id", "template_key");

-- AddForeignKey
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_product_mappings" ADD CONSTRAINT "delivery_product_mappings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_product_mappings" ADD CONSTRAINT "delivery_product_mappings_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_product_mappings" ADD CONSTRAINT "delivery_product_mappings_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_template_overrides" ADD CONSTRAINT "whatsapp_template_overrides_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- Row-Level Security for the new tenant-owned tables (same policy as every
-- previous phase).
-- ============================================================================
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['integration_connections', 'delivery_product_mappings', 'whatsapp_template_overrides']
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
