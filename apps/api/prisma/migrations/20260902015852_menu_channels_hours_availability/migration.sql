-- CreateEnum
CREATE TYPE "ordering_channel" AS ENUM ('dine_in', 'takeaway', 'delivery');

-- AlterTable
ALTER TABLE "branches" ADD COLUMN     "auto_pause_threshold" INTEGER,
ADD COLUMN     "auto_slowdown_threshold" INTEGER,
ADD COLUMN     "delivery_estimated_minutes" INTEGER NOT NULL DEFAULT 45,
ADD COLUMN     "delivery_fee_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "delivery_min_order_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "delivery_radius_km" DECIMAL(6,2),
ADD COLUMN     "pickup_estimated_minutes" INTEGER NOT NULL DEFAULT 20,
ADD COLUMN     "self_service_payment_methods" JSONB NOT NULL DEFAULT '["cash"]';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "delivery_address" TEXT,
ADD COLUMN     "delivery_fee_amount" DECIMAL(12,2),
ADD COLUMN     "delivery_lat" DECIMAL(9,6),
ADD COLUMN     "delivery_lng" DECIMAL(9,6),
ADD COLUMN     "intended_payment_method" "payment_method";

-- AlterTable
ALTER TABLE "product_branch_settings" ADD COLUMN     "sold_out_date" DATE,
ADD COLUMN     "unavailable_reason" TEXT;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "badges" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "prep_time_minutes" INTEGER;

-- CreateTable
CREATE TABLE "branch_channel_pauses" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "channel" "ordering_channel" NOT NULL,
    "reason" TEXT,
    "paused_until" TIMESTAMP(3),
    "paused_by" UUID,
    "paused_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "branch_channel_pauses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_channel_overrides" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "channel" "ordering_channel" NOT NULL,
    "is_visible" BOOLEAN NOT NULL DEFAULT true,
    "price_override" DECIMAL(12,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,

    CONSTRAINT "product_channel_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "modifier_branch_settings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "modifier_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "is_available" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,

    CONSTRAINT "modifier_branch_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "branch_channel_pauses_tenant_id_branch_id_idx" ON "branch_channel_pauses"("tenant_id", "branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "branch_channel_pauses_branch_id_channel_key" ON "branch_channel_pauses"("branch_id", "channel");

-- CreateIndex
CREATE INDEX "product_channel_overrides_tenant_id_branch_id_channel_idx" ON "product_channel_overrides"("tenant_id", "branch_id", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "product_channel_overrides_product_id_branch_id_channel_key" ON "product_channel_overrides"("product_id", "branch_id", "channel");

-- CreateIndex
CREATE INDEX "modifier_branch_settings_tenant_id_branch_id_idx" ON "modifier_branch_settings"("tenant_id", "branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "modifier_branch_settings_modifier_id_branch_id_key" ON "modifier_branch_settings"("modifier_id", "branch_id");

-- AddForeignKey
ALTER TABLE "branch_channel_pauses" ADD CONSTRAINT "branch_channel_pauses_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_channel_pauses" ADD CONSTRAINT "branch_channel_pauses_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_channel_overrides" ADD CONSTRAINT "product_channel_overrides_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_channel_overrides" ADD CONSTRAINT "product_channel_overrides_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_channel_overrides" ADD CONSTRAINT "product_channel_overrides_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modifier_branch_settings" ADD CONSTRAINT "modifier_branch_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modifier_branch_settings" ADD CONSTRAINT "modifier_branch_settings_modifier_id_fkey" FOREIGN KEY ("modifier_id") REFERENCES "modifiers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modifier_branch_settings" ADD CONSTRAINT "modifier_branch_settings_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- Row-Level Security for the new tenant-owned tables (same policy as every
-- previous phase).
-- ============================================================================
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['branch_channel_pauses', 'product_channel_overrides', 'modifier_branch_settings']
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
