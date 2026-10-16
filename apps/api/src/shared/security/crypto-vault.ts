import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * Encrypts secrets that must be stored (not just hashed) — ZATCA CSID
 * material, and now third-party integration credentials (delivery
 * platform / payment gateway / NFC terminal / WhatsApp API keys). Password-
 * style values (user, platform admin) never go through here: those are
 * hashed one-way in identity/password.ts and don't need decryption.
 *
 * AES-256-GCM, one env-provided key for the whole deployment (rotate by
 * re-encrypting; out of scope for the MVP). Each value gets its own random
 * IV, stored alongside the ciphertext so decryption never depends on
 * external state beyond the key itself.
 *
 * `namespace` only changes the key-derivation salt — it does not add a
 * second secret to configure. Every caller still reuses the one
 * ZATCA_CREDENTIALS_ENCRYPTION_KEY env var (kept under its original name
 * for backward compatibility; it's really "the app's secret-encryption
 * key", not ZATCA-specific). Different namespaces just avoid the same
 * derived key protecting unrelated categories of secret.
 */
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit GCM nonce, the recommended size

function deriveKey(namespace: string): Buffer {
  const secret = process.env.ZATCA_CREDENTIALS_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error(
      "ZATCA_CREDENTIALS_ENCRYPTION_KEY is not set — required to store/read encrypted credentials",
    );
  }
  // scrypt with a fixed, app-specific salt: the secret itself is the only
  // thing protecting these values, so a per-value random salt would add
  // nothing (the key material is generated fresh from the same env secret
  // every time) while making the derivation slower for no benefit.
  return scryptSync(secret, `spruvex-r-${namespace}-vault`, 32);
}

/** Encrypts one string; returns `iv:authTag:ciphertext`, all hex. */
export function encryptSecret(plaintext: string, namespace = "zatca"): string {
  const key = deriveKey(namespace);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

/** Decrypts a value produced by encryptSecret (same namespace it was encrypted with). Throws if the key is wrong or the value was tampered with. */
export function decryptSecret(stored: string, namespace = "zatca"): string {
  const [ivHex, authTagHex, ciphertextHex] = stored.split(":");
  if (!ivHex || !authTagHex || !ciphertextHex) {
    throw new Error("Malformed encrypted value");
  }
  const key = deriveKey(namespace);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

/** Namespace for third-party integration credentials (delivery/payment/NFC/WhatsApp) — keeps their derived key distinct from ZATCA's. */
export const INTEGRATIONS_VAULT_NAMESPACE = "integrations";
