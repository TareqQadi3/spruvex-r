import {
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from "@nestjs/common";

import { AuditService } from "../../shared/audit/audit.service";
import { LimitsService } from "../../shared/billing/limits.service";
import { ResendService } from "../../shared/email/resend.service";
import { staffCredentialsEmail } from "../../shared/email/templates";
import { RequireAuthenticated } from "../../shared/rbac/require-authenticated.decorator";
import { RequirePermission } from "../../shared/rbac/require-permission.decorator";
import { PlatformPrismaService } from "../../shared/prisma/platform-prisma.service";
import { PrismaService } from "../../shared/prisma/prisma.service";
import { TenantContextService } from "../../shared/tenancy/tenant-context.service";
import { hashPassword } from "../identity/password";
import { UpdateOrderingSettingsDto } from "./dto/branch-ordering-settings.dto";
import { AddTeamMemberDto } from "./dto/onboarding.dto";
import { UpdateTenantDto } from "./dto/tenant-settings.dto";

function dashboardUrl(): string {
  return process.env.DASHBOARD_BASE_URL ?? "http://localhost:5173";
}

/** Read endpoints backing the dashboard shell (branches / team / roles / restaurant info). */
@Controller()
export class TenancyController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly platformDb: PlatformPrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
    private readonly limits: LimitsService,
    private readonly resend: ResendService,
  ) {}

  @RequirePermission("tenant.settings.manage")
  @Get("tenant")
  async tenant() {
    const tenant = await this.prisma.scoped.tenant.findUnique({
      where: { id: this.tenantContext.tenantIdOrThrow },
      select: {
        id: true,
        name: true,
        nameEn: true,
        slug: true,
        logoUrl: true,
        legalName: true,
        type: true,
        country: true,
        currency: true,
        defaultLocale: true,
        vatNumber: true,
        crNumber: true,
        address: true,
        vatRate: true,
        onboardingCompletedAt: true,
      },
    });
    return {
      ...tenant,
      /** Base URL of the customer ordering app (public menu links). */
      publicBaseUrl: (process.env.ORDERING_BASE_URL ?? "").replace(/\/+$/, ""),
    };
  }

  /** Establishment / ZATCA data (legal name, VAT number, CR, address). */
  @RequirePermission("tenant.settings.manage")
  @Patch("tenant")
  async updateTenant(@Body() dto: UpdateTenantDto) {
    const ctx = this.tenantContext.contextOrThrow;
    const tenant = await this.prisma.scoped.tenant.update({
      where: { id: this.tenantContext.tenantIdOrThrow },
      data: { ...dto, updatedBy: ctx.userId },
      select: {
        id: true,
        name: true,
        nameEn: true,
        legalName: true,
        vatNumber: true,
        crNumber: true,
        address: true,
      },
    });
    await this.audit.log({
      action: "tenant.settings_updated",
      entityType: "tenant",
      entityId: tenant.id,
      meta: { changes: { ...dto } },
    });
    return tenant;
  }

  @RequirePermission("branches.manage")
  @Get("branches")
  branches() {
    return this.prisma.scoped.branch.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        nameEn: true,
        slug: true,
        address: true,
        phone: true,
        email: true,
        isActive: true,
        orderingSettings: true,
        createdAt: true,
      },
    });
  }

  /**
   * Self-ordering settings for one branch: enable/disable QR table
   * ordering, require-cashier-confirmation. Also returns the public menu
   * link so the dashboard can show/copy it.
   */
  @RequirePermission("branches.manage")
  @Patch("branches/:id/ordering-settings")
  async updateOrderingSettings(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateOrderingSettingsDto,
  ) {
    const ctx = this.tenantContext.contextOrThrow;
    const existing = await this.prisma.scoped.branch.findFirst({
      where: { id, deletedAt: null },
      select: { orderingSettings: true },
    });
    if (!existing) {
      throw new NotFoundException("Branch not found");
    }
    const current = (existing.orderingSettings ?? {}) as Record<string, unknown>;

    const branch = await this.prisma.scoped.branch.update({
      where: { id },
      data: {
        orderingSettings: { ...current, ...dto },
        updatedBy: ctx.userId,
      },
      select: { id: true, slug: true, orderingSettings: true },
    });
    await this.audit.log({
      action: "branch.ordering_settings_updated",
      entityType: "branch",
      entityId: id,
      branchId: id,
      meta: { changes: { ...dto } },
    });
    return branch;
  }

  /**
   * Branches the signed-in member can work in (KDS/POS branch picker).
   * Membership with branchId=null means tenant-wide access.
   */
  @RequireAuthenticated()
  @Get("my-branches")
  async myBranches() {
    const ctx = this.tenantContext.contextOrThrow;
    const memberships = await this.prisma.scoped.userRole.findMany({
      where: { userId: ctx.userId },
      select: { branchId: true },
    });
    const tenantWide = memberships.some((m) => m.branchId === null);
    const branchIds = memberships.map((m) => m.branchId).filter((id): id is string => !!id);

    return this.prisma.scoped.branch.findMany({
      where: {
        deletedAt: null,
        isActive: true,
        ...(tenantWide ? {} : { id: { in: branchIds } }),
      },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, nameEn: true, slug: true },
    });
  }

  @RequirePermission("users.manage")
  @Get("users")
  async users() {
    const memberships = await this.prisma.scoped.userRole.findMany({
      include: {
        user: { select: { id: true, name: true, email: true, isActive: true, lastLoginAt: true } },
        role: { select: { key: true, nameAr: true, nameEn: true } },
        branch: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    return memberships.map((m) => ({
      userId: m.user.id,
      name: m.user.name,
      email: m.user.email,
      isActive: m.user.isActive,
      lastLoginAt: m.user.lastLoginAt,
      role: m.role,
      branch: m.branch,
    }));
  }

  /** Add a team member to the current tenant (Team page "add member" action). */
  @RequirePermission("users.manage")
  @Post("users")
  async addUser(@Body() dto: AddTeamMemberDto) {
    const ctx = this.tenantContext.contextOrThrow;
    const tenantId = this.tenantContext.tenantIdOrThrow;

    await this.limits.assertCanAddUsers(tenantId, 1);

    const role = await this.prisma.scoped.role.findFirst({
      where: { key: dto.role, deletedAt: null },
    });
    if (!role) {
      throw new NotFoundException(`Unknown role: ${dto.role}`);
    }

    if (dto.branchId) {
      const branch = await this.prisma.scoped.branch.findFirst({
        where: { id: dto.branchId, deletedAt: null },
      });
      if (!branch) {
        throw new NotFoundException("Branch not found");
      }
    }

    const email = dto.email.toLowerCase();
    const existingUser = await this.platformDb.user.findUnique({ where: { email } });
    if (existingUser) {
      const alreadyMember = await this.prisma.scoped.userRole.findFirst({
        where: { userId: existingUser.id },
      });
      if (alreadyMember) {
        throw new ConflictException(`An account with email ${email} is already on this team`);
      }
    }

    const user =
      existingUser ??
      (await this.platformDb.user.create({
        data: {
          name: dto.name,
          email,
          passwordHash: await hashPassword(dto.password),
          emailVerifiedAt: new Date(),
        },
      }));

    // Only a brand-new account has a password worth emailing — an existing
    // user just being added to another tenant keeps whatever password they
    // already had, which dto.password was never applied to.
    if (!existingUser) {
      const tenant = await this.prisma.scoped.tenant.findUnique({
        where: { id: tenantId },
        select: { name: true },
      });
      const { subject, html } = staffCredentialsEmail(
        dto.name,
        tenant?.name ?? "SpruVex R",
        email,
        dto.password,
        dashboardUrl(),
      );
      await this.resend.send(email, subject, html);
    }

    const membership = await this.prisma.scoped.userRole.create({
      data: {
        tenantId,
        userId: user.id,
        roleId: role.id,
        branchId: dto.branchId ?? null,
        createdBy: ctx.userId,
      },
      include: {
        user: { select: { id: true, name: true, email: true, isActive: true, lastLoginAt: true } },
        role: { select: { key: true, nameAr: true, nameEn: true } },
        branch: { select: { id: true, name: true } },
      },
    });

    await this.audit.log({
      action: "user.role_assigned",
      entityType: "user",
      entityId: user.id,
      meta: { email, role: dto.role, branchId: dto.branchId ?? null },
    });

    return {
      userId: membership.user.id,
      name: membership.user.name,
      email: membership.user.email,
      isActive: membership.user.isActive,
      lastLoginAt: membership.user.lastLoginAt,
      role: membership.role,
      branch: membership.branch,
    };
  }

  /** Remove a team member's membership from the current tenant. */
  @RequirePermission("users.manage")
  @Delete("users/:userId")
  async removeUser(@Param("userId", ParseUUIDPipe) userId: string) {
    const ctx = this.tenantContext.contextOrThrow;
    if (userId === ctx.userId) {
      throw new ForbiddenException("You cannot remove your own account");
    }

    const membership = await this.prisma.scoped.userRole.findFirst({
      where: { userId },
      include: { role: { select: { key: true } } },
    });
    if (!membership) {
      throw new NotFoundException("Team member not found");
    }
    if (membership.role.key === "owner") {
      throw new ForbiddenException("The restaurant owner cannot be removed");
    }

    await this.prisma.scoped.userRole.deleteMany({ where: { userId } });

    await this.audit.log({
      action: "user.role_removed",
      entityType: "user",
      entityId: userId,
    });
    return { removed: true };
  }

  @RequirePermission("users.manage")
  @Get("roles")
  roles() {
    return this.prisma.scoped.role.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        key: true,
        nameAr: true,
        nameEn: true,
        isSystem: true,
        rolePermissions: { select: { permission: { select: { key: true } } } },
      },
    });
  }
}
