import {
  BadRequestException,
  ConflictException,
  Injectable,
} from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";

import { DOMAIN_EVENTS, type SystemRole } from "@spruvex-r/types";

import { AuditService } from "../../shared/audit/audit.service";
import { LimitsService } from "../../shared/billing/limits.service";
import { ResendService } from "../../shared/email/resend.service";
import { staffCredentialsEmail, welcomeEmail } from "../../shared/email/templates";
import { PlatformPrismaService } from "../../shared/prisma/platform-prisma.service";
import { PrismaService } from "../../shared/prisma/prisma.service";
import { TenantContextService } from "../../shared/tenancy/tenant-context.service";
import { hashPassword } from "../identity/password";
import { TokenService, type TokenPair } from "../identity/token.service";
import { OPTIONAL_SETUP_STEPS, type OptionalSetupStep } from "./dto/onboarding.dto";
import { provisionTenant } from "./tenant-provisioning";

function dashboardUrl(): string {
  return process.env.DASHBOARD_BASE_URL ?? "http://localhost:5173";
}

function slugify(value: string): string {
  const base = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9؀-ۿ]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "restaurant";
}

export interface OnboardingStatus {
  /** 2 = restaurant info, 3 = first branch, 4 = staff, 5 = complete */
  step: 2 | 3 | 4 | 5 | "done";
  tenantId?: string;
  hasBranch: boolean;
  staffCount: number;
}

export interface SetupStatusItem {
  step: OptionalSetupStep;
  /** true once genuinely done (has real data) OR the owner explicitly skipped it. */
  done: boolean;
  skipped: boolean;
}

/**
 * The onboarding wizard. Step 1 (owner account) lives in the Identity module;
 * steps 2-5 here. Tenant creation runs on the platform connection (a tenant
 * cannot be created from inside a tenant context); everything after uses the
 * RLS-scoped client.
 */
@Injectable()
export class OnboardingService {
  constructor(
    private readonly platformDb: PlatformPrismaService,
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
    private readonly limits: LimitsService,
    private readonly resend: ResendService,
  ) {}

  /** Step 2 — create the restaurant. Returns fresh tokens carrying the new tenant context. */
  async createRestaurant(input: {
    name: string;
    nameEn?: string;
    type?: string;
    country?: string;
    currency?: string;
    defaultLocale?: string;
    logoUrl?: string;
    vatNumber: string;
    crNumber: string;
    address: string;
    city: string;
    district: string;
    buildingNumber: string;
    postalCode: string;
    additionalAddress: string;
    contactPhone: string;
  }): Promise<{ tenantId: string; tokens: TokenPair }> {
    const { userId } = this.tenantContext.contextOrThrow;

    const existing = await this.platformDb.userRole.findFirst({ where: { userId } });
    if (existing) {
      throw new ConflictException("This account already belongs to a restaurant");
    }

    const slug = await this.availableSlug(slugify(input.nameEn ?? input.name));
    const provisioned = await provisionTenant(this.platformDb, {
      ...input,
      slug,
      ownerUserId: userId,
    });

    await this.audit.log({
      tenantId: provisioned.tenantId,
      action: "tenant.created",
      entityType: "tenant",
      entityId: provisioned.tenantId,
      meta: { name: input.name, slug },
    });
    this.events.emit(DOMAIN_EVENTS.TENANT_CREATED, { tenantId: provisioned.tenantId });

    const user = await this.platformDb.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, email: true, name: true },
    });

    const { subject, html } = welcomeEmail(user.name, input.name, dashboardUrl());
    await this.resend.send(user.email, subject, html);

    return {
      tenantId: provisioned.tenantId,
      tokens: await this.tokens.issueTokenPair(user),
    };
  }

  /** Step 3 — create the first branch (RLS-scoped). */
  async createBranch(input: {
    name: string;
    nameEn?: string;
    address?: string;
    phone?: string;
    email?: string;
  }): Promise<{ branchId: string }> {
    const ctx = this.tenantContext.contextOrThrow;
    const tenantId = this.tenantContext.tenantIdOrThrow;

    await this.limits.assertCanAddBranch(tenantId);

    const count = await this.prisma.scoped.branch.count({ where: { deletedAt: null } });
    const branch = await this.prisma.scoped.branch.create({
      data: {
        tenantId,
        name: input.name,
        nameEn: input.nameEn,
        slug: count === 0 ? "main" : `branch-${count + 1}`,
        address: input.address,
        phone: input.phone,
        email: input.email,
        createdBy: ctx.userId,
      },
    });

    await this.audit.log({
      action: "branch.created",
      entityType: "branch",
      entityId: branch.id,
      meta: { name: input.name },
    });
    return { branchId: branch.id };
  }

  /** Step 4 — create the first staff users (manager / cashier) with roles. */
  async createStaff(
    users: Array<{
      name: string;
      email: string;
      password: string;
      role: Exclude<SystemRole, "owner">;
      branchId?: string;
    }>,
  ): Promise<{ created: Array<{ userId: string; email: string; role: string }> }> {
    const ctx = this.tenantContext.contextOrThrow;
    const tenantId = this.tenantContext.tenantIdOrThrow;

    await this.limits.assertCanAddUsers(tenantId, users.length);

    const [roles, tenant] = await Promise.all([
      this.prisma.scoped.role.findMany({ where: { deletedAt: null } }),
      this.prisma.scoped.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } }),
    ]);
    const roleByKey = new Map(roles.map((r) => [r.key, r]));

    const created: Array<{ userId: string; email: string; role: string }> = [];
    for (const input of users) {
      const role = roleByKey.get(input.role);
      if (!role) {
        throw new BadRequestException(`Unknown role: ${input.role}`);
      }

      const email = input.email.toLowerCase();
      const existingUser = await this.platformDb.user.findUnique({ where: { email } });
      if (existingUser) {
        throw new ConflictException(`An account with email ${email} already exists`);
      }

      // Staff accounts are created by the owner — considered verified.
      const user = await this.platformDb.user.create({
        data: {
          name: input.name,
          email,
          passwordHash: await hashPassword(input.password),
          emailVerifiedAt: new Date(),
        },
      });
      await this.prisma.scoped.userRole.create({
        data: {
          tenantId,
          userId: user.id,
          roleId: role.id,
          branchId: input.branchId ?? null,
          createdBy: ctx.userId,
        },
      });

      await this.audit.log({
        action: "user.role_assigned",
        entityType: "user",
        entityId: user.id,
        meta: { email, role: input.role, branchId: input.branchId ?? null },
      });
      const { subject, html } = staffCredentialsEmail(input.name, tenant.name, email, input.password, dashboardUrl());
      await this.resend.send(email, subject, html);
      created.push({ userId: user.id, email, role: input.role });
    }
    return { created };
  }

  /** Step 5 — mark onboarding complete. */
  async complete(): Promise<{ completedAt: Date }> {
    const tenantId = this.tenantContext.tenantIdOrThrow;
    const hasBranch = await this.prisma.scoped.branch.count({ where: { deletedAt: null } });
    if (hasBranch === 0) {
      throw new BadRequestException("Create at least one branch before completing setup");
    }

    const completedAt = new Date();
    await this.prisma.scoped.tenant.update({
      where: { id: tenantId },
      data: { onboardingCompletedAt: completedAt },
    });
    await this.audit.log({ action: "tenant.onboarding_completed", entityType: "tenant", entityId: tenantId });
    return { completedAt };
  }

  async status(): Promise<OnboardingStatus> {
    const ctx = this.tenantContext.contextOrThrow;
    if (!ctx.tenantId) {
      return { step: 2, hasBranch: false, staffCount: 0 };
    }

    const [tenant, branchCount, memberCount] = await Promise.all([
      this.prisma.scoped.tenant.findUnique({ where: { id: ctx.tenantId } }),
      this.prisma.scoped.branch.count({ where: { deletedAt: null } }),
      this.prisma.scoped.userRole.count(),
    ]);

    if (tenant?.onboardingCompletedAt) {
      return { step: "done", tenantId: ctx.tenantId, hasBranch: branchCount > 0, staffCount: memberCount - 1 };
    }
    return {
      step: branchCount === 0 ? 3 : memberCount <= 1 ? 4 : 5,
      tenantId: ctx.tenantId,
      hasBranch: branchCount > 0,
      staffCount: memberCount - 1,
    };
  }

  /**
   * The dashboard "missing setup" reminder banner reads this — every
   * optional onboarding-hub step the owner hasn't yet either completed or
   * explicitly skipped. Tracked in tenant.settings (a JSON column that was
   * otherwise unused) rather than inferred from data presence: a genuinely
   * blank receipt footer note, for instance, is indistinguishable from
   * "never visited" by data alone, but the owner explicitly choosing
   * "skip" vs never having seen the step are different things worth
   * surfacing differently.
   */
  async getSetupStatus(): Promise<SetupStatusItem[]> {
    const tenantId = this.tenantContext.tenantIdOrThrow;
    const tenant = await this.prisma.scoped.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { settings: true },
    });
    const recorded = (tenant.settings as { onboardingSteps?: Record<string, "done" | "skipped"> })
      .onboardingSteps ?? {};

    return OPTIONAL_SETUP_STEPS.map((step) => ({
      step,
      done: recorded[step] === "done",
      skipped: recorded[step] === "skipped",
    }));
  }

  /** Marks one optional step done (owner saved real data) or skipped (owner deferred it). */
  async markSetupStep(step: OptionalSetupStep, status: "done" | "skipped"): Promise<void> {
    const tenantId = this.tenantContext.tenantIdOrThrow;
    const tenant = await this.prisma.scoped.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { settings: true },
    });
    const settings = (tenant.settings ?? {}) as { onboardingSteps?: Record<string, "done" | "skipped"> };
    const onboardingSteps = { ...(settings.onboardingSteps ?? {}), [step]: status };

    await this.prisma.scoped.tenant.update({
      where: { id: tenantId },
      data: { settings: { ...settings, onboardingSteps } },
    });
  }

  private async availableSlug(base: string): Promise<string> {
    let candidate = base;
    for (let i = 2; ; i++) {
      const taken = await this.platformDb.tenant.findUnique({ where: { slug: candidate } });
      if (!taken) return candidate;
      candidate = `${base}-${i}`;
    }
  }
}
