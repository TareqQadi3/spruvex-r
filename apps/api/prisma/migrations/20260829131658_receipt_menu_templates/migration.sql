-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "menu_custom_css" TEXT,
ADD COLUMN     "menu_template" TEXT NOT NULL DEFAULT 'classic',
ADD COLUMN     "receipt_logo_position" TEXT NOT NULL DEFAULT 'top-center',
ADD COLUMN     "receipt_logo_size" TEXT NOT NULL DEFAULT 'medium',
ADD COLUMN     "receipt_template" TEXT NOT NULL DEFAULT 'classic';
