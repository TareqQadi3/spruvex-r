import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * Encrypts secrets that must be stored (not just hashed) — currently the
 * per-tenant ZATCA CSID certificate/private key/secret. Password-style
 * values (user, platform admin) never go through here: those are hashed
 * one-way in identity/password.ts and don't need decryption.
 *
 * AES-256-GCM, one env-provided key for the whole deployment (rotate by
 * re-encrypting; out of scope for the MVP). Each value gets its own random
 * IV, stored alongside the ciphertext so decryption never depends on
 * external state beyond the key itself.
 */
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit GCM nonce, the recommended size

function deriveKey(): Buffer {
  const secret = process.env.ZATCA_CREDENTIALS_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error(
      "ZATCA_CREDENTIALS_ENCRYPTION_KEY is not set — required to store/read ZATCA CSID credentials",
    );
  }
  // scrypt with a fixed, app-specific salt: the secret itself is the only
  // thing protecting these values, so a per-value random salt would add
  // nothing (the key material is generated fresh from the same env secret
  // every time) while making the derivation slower for no benefit.
  return scryptSync(secret, "spruvex-r-zatca-vault", 32);
}

/** Encrypts one string; returns `iv:authTag:ciphertext`, all hex. */
export function encryptSecret(plaintext: string): string {
  const key = deriveKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

/** Decrypts a value produced by encryptSecret. Throws if the key is wrong or the value was tampered with. */
export function decryptSecret(stored: string): string {
  const [ivHex, authTagHex, ciphertextHex] = stored.split(":");
  if (!ivHex || !authTagHex || !ciphertextHex) {
    throw new Error("Malformed encrypted value");
  }
  const key = deriveKey();
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
