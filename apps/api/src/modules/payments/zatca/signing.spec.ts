import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicKey } from "node:crypto";

import { signInvoiceHash, verifyInvoiceSignature } from "./signing";

/**
 * ZATCA's CSID is a secp256k1 EC key pair issued as an X.509 certificate.
 * No real CSID exists in this environment (no ZATCA sandbox account), so
 * these tests generate a throwaway self-signed cert with the same curve —
 * enough to prove the sign/verify/public-key-extraction mechanics are
 * correct, independent of whether ZATCA's servers would accept this
 * particular certificate (they wouldn't; it isn't CSID-issued).
 */
describe("ZATCA Phase 2 cryptographic stamp", () => {
  let dir: string;
  let privateKeyPem: string;
  let certificatePem: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "zatca-test-"));
    const keyPath = join(dir, "key.pem");
    const certPath = join(dir, "cert.pem");
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "ec",
      "-pkeyopt", "ec_paramgen_curve:secp256k1",
      "-keyout", keyPath,
      "-out", certPath,
      "-days", "1",
      "-nodes",
      "-subj", "/CN=spruvex-r-test-csid",
    ]);
    privateKeyPem = readFileSync(keyPath, "utf8");
    certificatePem = readFileSync(certPath, "utf8");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("signs an invoice hash and the signature verifies against the certificate", () => {
    const invoiceHash = Buffer.from("a".repeat(64), "hex");
    const { signature, publicKey } = signInvoiceHash(invoiceHash, { privateKeyPem, certificatePem });

    expect(verifyInvoiceSignature(invoiceHash, signature, certificatePem)).toBe(true);
    // 0x04 (uncompressed marker) + 32-byte X + 32-byte Y
    expect(publicKey.length).toBe(65);
    expect(publicKey[0]).toBe(0x04);
  });

  it("rejects a signature over a different hash", () => {
    const invoiceHash = Buffer.from("b".repeat(64), "hex");
    const otherHash = Buffer.from("c".repeat(64), "hex");
    const { signature } = signInvoiceHash(invoiceHash, { privateKeyPem, certificatePem });

    expect(verifyInvoiceSignature(otherHash, signature, certificatePem)).toBe(false);
  });

  it("extracts the same public key Node itself reports for the certificate", () => {
    const invoiceHash = Buffer.from("d".repeat(64), "hex");
    const { publicKey } = signInvoiceHash(invoiceHash, { privateKeyPem, certificatePem });

    const jwk = createPublicKey(certificatePem).export({ format: "jwk" }) as { x: string; y: string };
    const expectedX = Buffer.from(jwk.x, "base64url");
    const expectedY = Buffer.from(jwk.y, "base64url");

    expect(publicKey.subarray(1, 33).equals(expectedX)).toBe(true);
    expect(publicKey.subarray(33, 65).equals(expectedY)).toBe(true);
  });
});
