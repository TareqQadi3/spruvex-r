/**
 * Canonical email normalization — one shared convention for every entry
 * point (self-registration, login, the marketing site's trial signup,
 * password reset) so that `user+tag@gmail.com` and `user@gmail.com` can
 * never become two separate accounts.
 *
 * Rules:
 * 1. trim + lowercase (was already the de-facto convention everywhere),
 * 2. strip a `+tag` suffix from the local part (`user+promo@x` → `user@x`) —
 *    Gmail (and most providers) ignore it, so it identifies the SAME mailbox
 *    and must identify the SAME account,
 * 3. Gmail dot-insensitivity is deliberately NOT collapsed (`u.s.e.r@gmail`
 *    stays as typed) — dots change the address Gmail-side only for gmail.com
 *    and admin tooling may rely on the exact address; the +tag rule alone
 *    closes the "unlimited trials from one inbox" loophole the project
 *    owner reported.
 */

/** Strips a `+tag` suffix from the local part and lowercases the address. */
export function normalizeEmail(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return trimmed; // not a valid address — validation layer rejects
  const local = trimmed.slice(0, at).replace(/\+[^@]*$/, "");
  const domain = trimmed.slice(at);
  return `${local}${domain}`;
}