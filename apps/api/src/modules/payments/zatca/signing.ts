/**
 * ZATCA Phase 2 — cryptographic stamp.
 *
 * ZATCA's CSID (Cryptographic Stamp Identifier) is an ECDSA key pair on the
 * secp256k1 curve, issued as an X.509 certificate via the Fatoora portal.
 * This module signs the invoice hash with that key (an XAdES-BES-shaped
 * detached signature) and extracts the raw public key bytes for the QR's
 * tag 8. It does not talk to ZATCA — it only implements the offline crypto
 * step, given whatever CSID materials the tenant has actually uploaded.
 */
import { createSign, createVerify, type KeyObject, createPrivateKey, createPublicKey } from "node:crypto";

export interface ZatcaCsid {
  /** PEM-encoded EC private key (secp256k1), from the CSID. */
  privateKeyPem: string;
  /** PEM-encoded X.509 certificate containing the CSID public key. */
  certificatePem: string;
}

export interface SignedInvoice {
  /** DER-encoded ECDSA signature over the invoice hash. */
  signature: Buffer;
  /** Raw (uncompressed SEC1) public key bytes from the certificate. */
  publicKey: Buffer;
}

/**
 * Signs the invoice hash with the CSID private key. `invoiceHash` is the raw
 * SHA-256 digest bytes (see hash-chain.ts) — ZATCA signs the hash itself,
 * not the XML a second time.
 */
export function signInvoiceHash(invoiceHash: Buffer, csid: ZatcaCsid): SignedInvoice {
  const privateKey = createPrivateKey(csid.privateKeyPem);
  const signer = createSign("SHA256");
  signer.update(invoiceHash);
  signer.end();
  const signature = signer.sign(privateKey);

  const publicKey = extractRawPublicKey(csid.certificatePem);
  return { signature, publicKey };
}

/** For tests, and for a future "verify before submitting" self-check. */
export function verifyInvoiceSignature(
  invoiceHash: Buffer,
  signature: Buffer,
  certificatePem: string,
): boolean {
  const publicKey = createPublicKey(certificatePem);
  const verifier = createVerify("SHA256");
  verifier.update(invoiceHash);
  verifier.end();
  return verifier.verify(publicKey, signature);
}

/** Uncompressed point length for a 256-bit curve (secp256k1/P-256): 0x04 prefix + 32-byte X + 32-byte Y. */
const EC_POINT_LENGTH_256 = 65;

function extractRawPublicKey(certificatePem: string): Buffer {
  const publicKey: KeyObject = createPublicKey(certificatePem);
  // Node's KeyObject API has no direct "raw EC point" export for EC keys, so
  // re-export as SPKI DER and take its final component: an EC SPKI's BIT
  // STRING (the uncompressed point) is always the last element in the
  // structure, with nothing after it — unlike searching for the 0x04 marker
  // byte, which can spuriously match earlier length/tag bytes in the DER.
  const der = publicKey.export({ format: "der", type: "spki" });
  const point = der.subarray(der.length - EC_POINT_LENGTH_256);
  if (point[0] !== 0x04) {
    throw new Error(
      "Unexpected public key encoding — expected an uncompressed EC point (secp256k1/P-256)",
    );
  }
  return Buffer.from(point);
}
