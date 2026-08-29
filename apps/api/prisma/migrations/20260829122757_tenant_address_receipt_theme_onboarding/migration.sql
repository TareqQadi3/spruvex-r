-- AlterTable
ALTER TABLE "branch_invoice_chains" ALTER COLUMN "tenant_id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "credit_notes" ALTER COLUMN "tenant_id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "debit_notes" ALTER COLUMN "tenant_id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "refunds" ALTER COLUMN "tenant_id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "additional_address" TEXT,
ADD COLUMN     "building_number" TEXT,
ADD COLUMN     "city" TEXT,
ADD COLUMN     "contact_phone" TEXT,
ADD COLUMN     "district" TEXT,
ADD COLUMN     "postal_code" TEXT,
ADD COLUMN     "receipt_footer_note" TEXT,
ADD COLUMN     "receipt_header_note" TEXT,
ADD COLUMN     "theme_color" TEXT NOT NULL DEFAULT 'green';
