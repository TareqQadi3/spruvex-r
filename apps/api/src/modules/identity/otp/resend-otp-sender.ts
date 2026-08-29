import { Injectable } from "@nestjs/common";

import { ResendService } from "../../../shared/email/resend.service";
import { otpEmail } from "../../../shared/email/templates";
import type { OtpPurpose, OtpSender } from "./otp-sender";

@Injectable()
export class ResendOtpSender implements OtpSender {
  constructor(private readonly resend: ResendService) {}

  async send(destination: string, code: string, purpose: OtpPurpose): Promise<void> {
    const { subject, html } = otpEmail(code, purpose);
    await this.resend.send(destination, subject, html);
  }
}
