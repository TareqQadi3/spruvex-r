-- One-time handoff tokens: let the marketing site hand a freshly-verified
-- merchant to the dashboard ALREADY SIGNED IN (closing the §7.4 gap in
-- HANDOFF.md). The site's verify proxy calls /auth/handoff/claim right after
-- a successful OTP verification; the dashboard consumes the token at boot via
-- POST /auth/handoff and exchanges it for a full token pair.
--
-- Deliberately NOT a JWT: it must be revocable server-side (single use,
-- short TTL), which is exactly what a database row gives us.

CREATE TABLE "handoff_tokens" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "token_hash" TEXT NOT NULL UNIQUE,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT now()
);

CREATE INDEX "handoff_tokens_token_hash_idx" ON "handoff_tokens"("token_hash");
