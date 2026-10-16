import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";

/** SHA-256 of the canonical XML — this is what gets signed, and what tag 6 of the Phase 2 QR carries. */
export function hashXml(xml: string): Buffer {
  return createHash("sha256").update(xml, "utf8").digest();
}

export const ZATCA_GENESIS_HASH = "0".repeat(64);

/**
 * Locks and reads one branch's current chain tip, inside the caller's
 * transaction — two POS terminals in the same branch issuing documents
 * concurrently must never read the same previousInvoiceHash. Hold the
 * returned lock (i.e. don't commit) until `writeInvoiceChainHash` has run
 * for this same document.
 */
export async function lockInvoiceChainTip(
  tx: Prisma.TransactionClient,
  branchId: string,
): Promise<{ previousHash: string; rowExists: boolean }> {
  const [locked] = await tx.$queryRaw<{ last_hash: string }[]>`
    SELECT last_hash FROM branch_invoice_chains WHERE branch_id = ${branchId}::uuid FOR UPDATE
  `;
  return { previousHash: locked?.last_hash ?? ZATCA_GENESIS_HASH, rowExists: Boolean(locked) };
}

/** Advances the chain tip to `newHashHex`, once the new document's hash is known. */
export async function writeInvoiceChainHash(
  tx: Prisma.TransactionClient,
  tenantId: string,
  branchId: string,
  newHashHex: string,
  rowExists: boolean,
): Promise<void> {
  if (rowExists) {
    await tx.branchInvoiceChain.update({ where: { branchId }, data: { lastHash: newHashHex } });
  } else {
    await tx.branchInvoiceChain.create({ data: { tenantId, branchId, lastHash: newHashHex } });
  }
}
