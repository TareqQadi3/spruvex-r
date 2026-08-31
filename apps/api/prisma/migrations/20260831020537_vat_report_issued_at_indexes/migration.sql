-- CreateIndex
CREATE INDEX "credit_notes_tenant_id_issued_at_idx" ON "credit_notes"("tenant_id", "issued_at");

-- CreateIndex
CREATE INDEX "debit_notes_tenant_id_issued_at_idx" ON "debit_notes"("tenant_id", "issued_at");

-- CreateIndex
CREATE INDEX "receipts_tenant_id_issued_at_idx" ON "receipts"("tenant_id", "issued_at");
