import { Injectable, Logger } from "@nestjs/common";

/**
 * Thin wrapper over Resend's REST API (no SDK dependency — one POST with
 * fetch, which Node 22 ships natively). Used for every transactional email
 * the platform sends: OTP codes, welcome messages, staff login credentials.
 *
 * Falls back to logging (never throwing) when RESEND_API_KEY is unset, so
 * local dev / CI never needs a real key — but this must never happen in
 * production (env validation should catch a missing key there; this class
 * only guards against it silently blocking signups if that check is ever
 * bypassed).
 */
@Injectable()
export class ResendService {
  private readonly logger = new Logger("Email");
  private readonly apiKey = process.env.RESEND_API_KEY;
  private readonly from = process.env.RESEND_FROM_EMAIL ?? "SpruVex R <onboarding@resend.dev>";

  async send(to: string, subject: string, html: string): Promise<void> {
    if (!this.apiKey) {
      this.logger.warn(`RESEND_API_KEY not set — skipping email to ${to}: "${subject}"`);
      return;
    }

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: this.from, to, subject, html }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // Never let a broken email provider break the request that triggered
      // it (registration, staff invite, ...) — log loudly and move on.
      this.logger.error(`Resend send failed (${res.status}) to ${to}: ${body}`);
    }
  }
}
