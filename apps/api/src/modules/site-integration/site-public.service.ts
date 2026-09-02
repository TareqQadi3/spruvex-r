import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { TRIAL_PERIOD_DAYS } from "@spruvex-r/types";

import { AuditService } from "../../shared/audit/audit.service";
import { dashboardUrl } from "../../shared/config/dashboard-url";
import { normalizeEmail } from "../identity/email-normalization";
import { HandoffService } from "../identity/handoff.service";
import { PlatformPrismaService } from "../../shared/prisma/platform-prisma.service";
import { TenantContextService } from "../../shared/tenancy/tenant-context.service";
import { hashPassword } from "../identity/password";
import { OtpService } from "../identity/otp/otp.service";
import { findAvailableSlug, provisionTenant, slugify } from "../tenancy/tenant-provisioning";
import type { PublicTrialSignupDto } from "./dto/site-public.dto";

export interface PublicTrialSignupResult {
  tenantId: string;
  slug: string;
  email: string;
  trialEndsAt: Date;
  dashboardUrl: string;
  /**
   * One-time auto sign-in token for this merchant: the marketing site's
   * verify proxy returns it to the browser AFTER a successful OTP check,
   * and the dashboard exchanges it at POST /auth/handoff — the merchant
   * lands inside the app without re-typing credentials (closes §7.4).
   */
  handoffToken: string;
  /** Same non-production-only convention as OtpService.issue(). */
  devOtp?: string;
}

/**
 * Provisions a real trial tenant for an unauthenticated request from the
 * spruvex-site marketing site — the ONLY entry point that creates a tenant
 * without a human first completing the register → verify-email → onboarding
 * wizard flow. It deliberately reuses that exact same machinery
 * (provisionTenant, the OTP "email_verification" purpose, the same phone
 * pattern) instead of a parallel implementation, per the "no parallel
 * tenant-creation logic" requirement.
 */
@Injectable()
export class SitePublicService {
  private readonly logger = new Logger("SitePublicService");

  constructor(
    private readonly platformDb: PlatformPrismaService,
    private readonly otp: OtpService,
    private readonly handoff: HandoffService,
    private readonly audit: AuditService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async createTrial(
    input: PublicTrialSignupDto,
    meta: { ip?: string },
  ): Promise<PublicTrialSignupResult> {
    const email = normalizeEmail(input.email);

    // Recovery path for a stuck unverified account — MUST run before the
    // phone check: someone who started at the dashboard wizard (register,
    // no tenant yet) and then tries the marketing-site form with the SAME
    // email and phone would otherwise hit the phone-409 dead end before we
    // ever reach the adoption logic. If this email already exists but was
    // never verified AND never got a tenant (an abandoned attempt — the
    // user closed the tab, the OTP email never arrived, ...), ADOPT it
    // instead of 409-ing into a dead end ("already registered" + login
    // refuses "email not verified"). Refresh their details, including the
    // newly chosen password, and continue provisioning the trial below —
    // exactly like AuthService.register()'s unverified re-registration
    // path. A verified account, or one that already owns a tenant, keeps
    // the real 409 (a genuine duplicate).
    const existingByEmail = await this.platformDb.user.findUnique({
      where: { email },
      include: { userRoles: { select: { id: true } } },
    });
    if (existingByEmail?.emailVerifiedAt || (existingByEmail && existingByEmail.userRoles.length > 0)) {
      throw new ConflictException("An account with this email already exists.");
    }

    // One free trial per phone number — the explicit anti-abuse rule this
    // endpoint was built for. ADOPTED accounts are exempt (same human,
    // finishing what they started): the check below compares phones only for
    // genuinely new accounts, and the phone column's own unique constraint
    // (caught below) remains the authoritative guard against races. If the
    // adopted account's phone differs from input.phone, the update inside
    // the try-block re-points it to the merchant's current number.
    if (!existingByEmail) {
      const existingByPhone = await this.platformDb.user.findUnique({
        where: { phone: input.phone },
      });
      if (existingByPhone) {
        throw new ConflictException(
          "This phone number already has a SpruVex R account — free trials are limited to one per restaurant.",
        );
      }
    }

    // The merchant chose this password themselves on the trial form —
    // hash and store it directly so they can log in later (no more random
    // placeholder that left every trial account effectively locked).
    const passwordHash = await hashPassword(input.password);

    let userId: string;
    try {
      const userData = {
        name: input.restaurantName,
        email,
        phone: input.phone,
        passwordHash,
      };
      // No `name` field on the trial-signup form — the restaurant name
      // doubles as the owner's display name until they set one in Settings.
      const user = existingByEmail
        ? await this.platformDb.user.update({ where: { id: existingByEmail.id }, data: userData })
        : await this.platformDb.user.create({ data: userData });
      userId = user.id;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const target = (err.meta?.target as string[] | undefined)?.join(",") ?? "";
        if (target.includes("phone")) {
          throw new ConflictException(
            "This phone number already has a SpruVex R account — free trials are limited to one per restaurant.",
          );
        }
        throw new ConflictException("An account with this email already exists.");
      }
      throw err;
    }

    const slug = await findAvailableSlug(this.platformDb, slugify(input.restaurantName));

    let tenantId: string;
    let trialEndsAt: Date;
    try {
      const provisioned = await provisionTenant(this.platformDb, {
        name: input.restaurantName,
        slug,
        ownerUserId: userId,
        type: input.businessType, // pass through to Tenant.type, like the wizard does
        branch: {}, // auto-create a default branch — no interactive wizard here to do step 3 later
      });
      tenantId = provisioned.tenantId;

      const subscription = await this.platformDb.subscription.findUniqueOrThrow({
        where: { tenantId },
        select: { trialEndsAt: true },
      });
      trialEndsAt =
        subscription.trialEndsAt ??
        new Date(Date.now() + TRIAL_PERIOD_DAYS * 24 * 60 * 60 * 1000);
    } catch (err) {
      // provisionTenant runs in its own transaction — a failure here leaves
      // an unverified, tenant-less user, exactly the same recoverable state
      // AuthService.register()'s "existing unverified user" path already
      // handles (they can re-register with the same email to retry).
      this.logger.error(`Trial provisioning failed for ${email}`, err instanceof Error ? err.stack : err);
      throw new InternalServerErrorException(
        "Could not finish creating the trial restaurant — please try again.",
      );
    }

    await this.tenantContext.run(
      { userId, tenantId, branchId: undefined, permissions: new Set() },
      async () => {
        await this.audit.log({
          action: "tenant.created",
          entityType: "tenant",
          entityId: tenantId,
          ip: meta.ip,
          meta: {
            source: "spruvex-site-trial-signup",
            restaurantName: input.restaurantName,
            slug,
          },
        });
      },
    );

    // Reuses the exact registration OTP purpose/flow: the merchant enters
    // this code (with their email) at POST /auth/register/verify — the same
    // endpoint every self-registered owner already uses — to log in for the
    // first time. See report for why this was chosen over a magic link.
    const { devCode } = await this.otp.issue(email, "email_verification", userId);

    const { token: handoffToken } = await this.handoff.issue(userId);

    return {
      tenantId,
      slug,
      email,
      trialEndsAt,
      dashboardUrl: dashboardUrl(),
      handoffToken,
      devOtp: devCode,
    };
  }
}
