-- AlterEnum
ALTER TYPE "order_status" ADD VALUE 'refunded';

-- AlterTable
ALTER TABLE "ingredients" ALTER COLUMN "tenant_id" DROP DEFAULT;

-- AlterTable
-- document_uuid added nullable + backfilled before being made required —
-- receipts is very likely non-empty by the time this runs (RESTORE_TENANT_ID
-- DEFAULTS migration history shows this table already carries real rows in
-- some environments), and a plain NOT NULL ADD COLUMN would fail on those.
ALTER TABLE "receipts" ADD COLUMN     "buyer_name" TEXT,
ADD COLUMN     "buyer_vat_number" TEXT,
ADD COLUMN     "cryptographic_stamp" TEXT,
ADD COLUMN     "document_uuid" UUID,
ADD COLUMN     "is_standard_invoice" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "xml_content" TEXT,
ADD COLUMN     "zatca_submitted_at" TIMESTAMP(3);

UPDATE "receipts" SET "document_uuid" = gen_random_uuid() WHERE "document_uuid" IS NULL;

ALTER TABLE "receipts" ALTER COLUMN "document_uuid" SET NOT NULL;

-- AlterTable
ALTER TABLE "recipe_items" ALTER COLUMN "tenant_id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "stock_levels" ALTER COLUMN "tenant_id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "stock_locations" ALTER COLUMN "tenant_id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "stock_movements" ALTER COLUMN "tenant_id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "subscription_invoices" ALTER COLUMN "tenant_id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "subscriptions" ALTER COLUMN "tenant_id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "zatca_csid_certificate_enc" TEXT,
ADD COLUMN     "zatca_csid_private_key_enc" TEXT,
ADD COLUMN     "zatca_csid_token_enc" TEXT,
ADD COLUMN     "zatca_csid_request_id" TEXT,
ADD COLUMN     "zatca_csid_secret_enc" TEXT,
ADD COLUMN     "zatca_environment" TEXT NOT NULL DEFAULT 'sandbox',
ADD COLUMN     "zatca_phase2_enabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "credit_notes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,
    "credit_note_number" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "vat_rate" DECIMAL(5,2) NOT NULL,
    "vat_amount" DECIMAL(12,2) NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "qr_payload" TEXT,
    "document_uuid" UUID NOT NULL,
    "is_standard_invoice" BOOLEAN NOT NULL DEFAULT false,
    "buyer_name" TEXT,
    "buyer_vat_number" TEXT,
    "xml_content" TEXT,
    "invoice_hash" TEXT,
    "previous_invoice_hash" TEXT,
    "cryptographic_stamp" TEXT,
    "zatca_status" TEXT NOT NULL DEFAULT 'not_submitted',
    "zatca_response" JSONB,
    "zatca_submitted_at" TIMESTAMP(3),
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issued_by" UUID,

    CONSTRAINT "credit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "debit_notes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,
    "debit_note_number" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "vat_rate" DECIMAL(5,2) NOT NULL,
    "vat_amount" DECIMAL(12,2) NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "qr_payload" TEXT,
    "document_uuid" UUID NOT NULL,
    "is_standard_invoice" BOOLEAN NOT NULL DEFAULT false,
    "buyer_name" TEXT,
    "buyer_vat_number" TEXT,
    "xml_content" TEXT,
    "invoice_hash" TEXT,
    "previous_invoice_hash" TEXT,
    "cryptographic_stamp" TEXT,
    "zatca_status" TEXT NOT NULL DEFAULT 'not_submitted',
    "zatca_response" JSONB,
    "zatca_submitted_at" TIMESTAMP(3),
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issued_by" UUID,

    CONSTRAINT "debit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,
    "credit_note_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "method" "payment_method" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reference" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branch_invoice_chains" (
    "branch_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "last_hash" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branch_invoice_chains_pkey" PRIMARY KEY ("branch_id")
);

-- CreateIndex (ZATCA requires each invoice/note UUID to be globally unique)
CREATE UNIQUE INDEX "receipts_document_uuid_key" ON "receipts"("document_uuid");

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_document_uuid_key" ON "credit_notes"("document_uuid");

-- CreateIndex
CREATE UNIQUE INDEX "debit_notes_document_uuid_key" ON "debit_notes"("document_uuid");

-- CreateIndex
CREATE INDEX "credit_notes_tenant_id_receipt_id_idx" ON "credit_notes"("tenant_id", "receipt_id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_branch_id_credit_note_number_key" ON "credit_notes"("branch_id", "credit_note_number");

-- CreateIndex
CREATE INDEX "debit_notes_tenant_id_receipt_id_idx" ON "debit_notes"("tenant_id", "receipt_id");

-- CreateIndex
CREATE UNIQUE INDEX "debit_notes_branch_id_debit_note_number_key" ON "debit_notes"("branch_id", "debit_note_number");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_credit_note_id_key" ON "refunds"("credit_note_id");

-- CreateIndex
CREATE INDEX "refunds_tenant_id_order_id_idx" ON "refunds"("tenant_id", "order_id");

-- CreateIndex
CREATE INDEX "refunds_tenant_id_shift_id_idx" ON "refunds"("tenant_id", "shift_id");

-- CreateIndex
CREATE INDEX "branch_invoice_chains_tenant_id_idx" ON "branch_invoice_chains"("tenant_id");

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_notes" ADD CONSTRAINT "debit_notes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_notes" ADD CONSTRAINT "debit_notes_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_credit_note_id_fkey" FOREIGN KEY ("credit_note_id") REFERENCES "credit_notes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_invoice_chains" ADD CONSTRAINT "branch_invoice_chains_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_invoice_chains" ADD CONSTRAINT "branch_invoice_chains_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- Row-Level Security for the new tenant-owned tables (same policy as every
-- previous phase). branch_invoice_chains is keyed by branch_id (one row per
-- branch) but still tenant_id-scoped like everything else.
-- ============================================================================
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['credit_notes', 'debit_notes', 'refunds', 'branch_invoice_chains']
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

-- credit_notes/debit_notes/refunds are append-only ledgers, same rule as
-- payments/receipts: a mistaken entry is corrected by issuing another
-- document, never by editing or deleting this one.
REVOKE UPDATE, DELETE ON "credit_notes" FROM spruvex_app;
REVOKE UPDATE, DELETE ON "debit_notes" FROM spruvex_app;
REVOKE UPDATE, DELETE ON "refunds" FROM spruvex_app;

-- Narrow exception, on receipts/credit_notes/debit_notes alike: the ZATCA
-- submission columns legitimately change after the row is created (Phase 2
-- Simplified/B2C invoices are reported to ZATCA asynchronously, within 24h,
-- and any submission can need a retry) — everything else on these rows
-- (amounts, VAT, the signed XML, the hash chain) stays fully immutable.
GRANT UPDATE ("zatca_status", "zatca_response", "zatca_submitted_at") ON "receipts" TO spruvex_app;
GRANT UPDATE ("zatca_status", "zatca_response", "zatca_submitted_at") ON "credit_notes" TO spruvex_app;
GRANT UPDATE ("zatca_status", "zatca_response", "zatca_submitted_at") ON "debit_notes" TO spruvex_app;
