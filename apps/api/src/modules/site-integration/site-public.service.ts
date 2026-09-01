import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import crypto from "node:crypto";

import { TRIAL_PERIOD_DAYS } from "@spruvex-r/types";

import { AuditService } from "../../shared/audit/audit.service";
import { dashboardUrl } from "../../shared/config/dashboard-url";
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
    private readonly audit: AuditService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async createTrial(
    input: PublicTrialSignupDto,
    meta: { ip?: string },
  ): Promise<PublicTrialSignupResult> {
    const email = input.email.toLowerCase();

    // One free trial per phone number — the explicit anti-abuse rule this
    // endpoint was built for. Checked up front for a clear error message;
    // the phone column's own unique constraint (caught below) is the
    // authoritative guard against a race between two concurrent requests.
    const existingByPhone = await this.platformDb.user.findUnique({
      where: { phone: input.phone },
    });
    if (existingByPhone) {
      throw new ConflictException(
        "This phone number already has a SpruVex R account — free trials are limited to one per restaurant.",
      );
    }

    const randomPassword = crypto.randomBytes(24).toString("base64url");
    const passwordHash = await hashPassword(randomPassword);

    let userId: string;
    try {
      // No `name` field on the trial-signup form — the restaurant name
      // doubles as the owner's display name until they set one in Settings.
      const user = await this.platformDb.user.create({
        data: {
          name: input.restaurantName,
          email,
          phone: input.phone,
          passwordHash,
        },
      });
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

    return {
      tenantId,
      slug,
      email,
      trialEndsAt,
      dashboardUrl: dashboardUrl(),
      devOtp: devCode,
    };
  }
}
