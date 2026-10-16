/**
 * ZATCA e-invoicing Phase 1 — simplified invoice QR code.
 *
 * The QR content is a Base64 string of TLV (Tag-Length-Value) records,
 * UTF-8 encoded, with the five mandatory tags:
 *   1  Seller name
 *   2  Seller VAT registration number
 *   3  Invoice timestamp (ISO 8601)
 *   4  Invoice total (with VAT)
 *   5  VAT amount
 */

export interface ZatcaQrInput {
  sellerName: string;
  vatNumber: string;
  /** ISO 8601 timestamp of issuance. */
  timestamp: string;
  /** Invoice total including VAT, as a decimal string (e.g. "115.00"). */
  total: string;
  /** VAT amount, as a decimal string (e.g. "15.00"). */
  vatAmount: string;
}

function tlv(tag: number, value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > 255) {
    throw new Error(`TLV value for tag ${tag} exceeds 255 bytes`);
  }
  return Buffer.concat([Buffer.from([tag, bytes.length]), bytes]);
}

/** Builds the Base64 TLV payload embedded in the receipt QR. */
export function buildZatcaQrPayload(input: ZatcaQrInput): string {
  return Buffer.concat([
    tlv(1, input.sellerName),
    tlv(2, input.vatNumber),
    tlv(3, input.timestamp),
    tlv(4, input.total),
    tlv(5, input.vatAmount),
  ]).toString("base64");
}

/** Decodes a TLV payload back into tag/value pairs (used by tests/tools). */
export function decodeZatcaQrPayload(payload: string): Map<number, string> {
  const bytes = Buffer.from(payload, "base64");
  const tags = new Map<number, string>();
  let offset = 0;
  while (offset + 2 <= bytes.length) {
    const tag = bytes[offset];
    const length = bytes[offset + 1];
    const value = bytes.subarray(offset + 2, offset + 2 + length);
    tags.set(tag, value.toString("utf8"));
    offset += 2 + length;
  }
  return tags;
}

/**
 * ZATCA e-invoicing Phase 2 — extends the Phase 1 QR with the cryptographic
 * chain: the invoice hash, the CSID-signed ECDSA signature over that hash,
 * the CSID's public key, and (only once ZATCA has countersigned the CSID
 * certificate) ZATCA's own signature over that public key. Tags 1-5 are
 * byte-for-byte identical to Phase 1 — a Phase 2 QR is a strict superset,
 * never a different encoding of the shared fields.
 */
export interface ZatcaPhase2QrInput extends ZatcaQrInput {
  /** Raw bytes of the invoice hash (not hex/base64 — TLV values are raw binary). */
  invoiceHash: Buffer;
  /** Raw ECDSA signature bytes over the invoice hash, produced by the CSID private key. */
  signature: Buffer;
  /** Raw public key bytes from the CSID certificate. */
  publicKey: Buffer;
  /** ZATCA's own signature over the CSID public key — absent until the CSID is countersigned. */
  stampSignature?: Buffer;
}

function tlvBinary(tag: number, value: Buffer): Buffer {
  if (value.length > 255) {
    throw new Error(`TLV value for tag ${tag} exceeds 255 bytes`);
  }
  return Buffer.concat([Buffer.from([tag, value.length]), value]);
}

export function buildZatcaPhase2QrPayload(input: ZatcaPhase2QrInput): string {
  const records = [
    tlv(1, input.sellerName),
    tlv(2, input.vatNumber),
    tlv(3, input.timestamp),
    tlv(4, input.total),
    tlv(5, input.vatAmount),
    tlvBinary(6, input.invoiceHash),
    tlvBinary(7, input.signature),
    tlvBinary(8, input.publicKey),
    ...(input.stampSignature ? [tlvBinary(9, input.stampSignature)] : []),
  ];
  return Buffer.concat(records).toString("base64");
}
