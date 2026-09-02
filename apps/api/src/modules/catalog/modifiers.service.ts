import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";

import { DOMAIN_EVENTS } from "@spruvex-r/types";

import { AuditService } from "../../shared/audit/audit.service";
import { PrismaService } from "../../shared/prisma/prisma.service";
import { TenantContextService } from "../../shared/tenancy/tenant-context.service";
import {
  CreateModifierDto,
  CreateModifierGroupDto,
  UpdateModifierDto,
  UpdateModifierGroupDto,
} from "./dto/modifier.dto";

/** min/max/required consistency shared by create + update. */
function validateSelectionRules(input: {
  isRequired?: boolean;
  minSelect?: number;
  maxSelect?: number | null;
}) {
  const min = input.minSelect ?? (input.isRequired ? 1 : 0);
  if (input.isRequired && min < 1) {
    throw new BadRequestException("Required groups need minSelect >= 1");
  }
  if (input.maxSelect != null && input.maxSelect < min) {
    throw new BadRequestException("maxSelect cannot be lower than minSelect");
  }
  return min;
}

@Injectable()
export class ModifiersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
  ) {}

  listGroups() {
    return this.prisma.scoped.modifierGroup.findMany({
      where: { deletedAt: null },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      include: {
        modifiers: {
          where: { deletedAt: null },
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          include: {
            branchSettings: {
              select: { branchId: true, isAvailable: true, branch: { select: { name: true, nameEn: true } } },
            },
          },
        },
        _count: { select: { products: true } },
      },
    });
  }

  async createGroup(dto: CreateModifierGroupDto) {
    const ctx = this.tenantContext.contextOrThrow;
    const minSelect = validateSelectionRules(dto);
    const group = await this.prisma.scoped.modifierGroup.create({
      data: {
        tenantId: this.tenantContext.tenantIdOrThrow,
        ...dto,
        minSelect,
        createdBy: ctx.userId,
      },
    });
    await this.audit.log({
      action: "modifier_group.created",
      entityType: "modifier_group",
      entityId: group.id,
      meta: { name: group.name },
    });
    return group;
  }

  async updateGroup(id: string, dto: UpdateModifierGroupDto) {
    const ctx = this.tenantContext.contextOrThrow;
    const existing = await this.groupOrThrow(id);
    validateSelectionRules({
      isRequired: dto.isRequired ?? existing.isRequired,
      minSelect: dto.minSelect ?? existing.minSelect,
      maxSelect: dto.maxSelect !== undefined ? dto.maxSelect : existing.maxSelect,
    });

    const group = await this.prisma.scoped.modifierGroup.update({
      where: { id },
      data: { ...dto, updatedBy: ctx.userId },
    });
    await this.audit.log({
      action: "modifier_group.updated",
      entityType: "modifier_group",
      entityId: id,
      meta: { changes: { ...dto } },
    });
    return group;
  }

  async deleteGroup(id: string) {
    const ctx = this.tenantContext.contextOrThrow;
    const group = await this.groupOrThrow(id);

    const attachedProducts = await this.prisma.scoped.productModifierGroup.count({
      where: { modifierGroupId: id },
    });
    if (attachedProducts > 0) {
      throw new ConflictException(
        "Modifier group is attached to products — detach it first",
      );
    }

    const now = new Date();
    await this.prisma.scoped.modifier.updateMany({
      where: { modifierGroupId: id, deletedAt: null },
      data: { deletedAt: now },
    });
    await this.prisma.scoped.modifierGroup.update({
      where: { id },
      data: { deletedAt: now, updatedBy: ctx.userId },
    });
    await this.audit.log({
      action: "modifier_group.deleted",
      entityType: "modifier_group",
      entityId: id,
      meta: { name: group.name },
    });
    return { deleted: true };
  }

  async createModifier(groupId: string, dto: CreateModifierDto) {
    const ctx = this.tenantContext.contextOrThrow;
    await this.groupOrThrow(groupId);
    const modifier = await this.prisma.scoped.modifier.create({
      data: {
        tenantId: this.tenantContext.tenantIdOrThrow,
        modifierGroupId: groupId,
        ...dto,
        createdBy: ctx.userId,
      },
    });
    await this.audit.log({
      action: "modifier.created",
      entityType: "modifier",
      entityId: modifier.id,
      meta: { name: modifier.name, priceAdjustment: dto.priceAdjustment ?? "0" },
    });
    return modifier;
  }

  async updateModifier(id: string, dto: UpdateModifierDto) {
    const ctx = this.tenantContext.contextOrThrow;
    await this.modifierOrThrow(id);
    const modifier = await this.prisma.scoped.modifier.update({
      where: { id },
      data: { ...dto, updatedBy: ctx.userId },
    });
    await this.audit.log({
      action: "modifier.updated",
      entityType: "modifier",
      entityId: id,
      meta: { changes: { ...dto } },
    });
    return modifier;
  }

  async deleteModifier(id: string) {
    const ctx = this.tenantContext.contextOrThrow;
    const modifier = await this.modifierOrThrow(id);
    await this.prisma.scoped.modifier.update({
      where: { id },
      data: { deletedAt: new Date(), updatedBy: ctx.userId },
    });
    await this.audit.log({
      action: "modifier.deleted",
      entityType: "modifier",
      entityId: id,
      meta: { name: modifier.name },
    });
    return { deleted: true };
  }

  /** Sets whether a single option (e.g. "Beef") is available at one branch — item 2. */
  async setBranchAvailability(id: string, branchId: string, isAvailable: boolean) {
    const ctx = this.tenantContext.contextOrThrow;
    const tenantId = this.tenantContext.tenantIdOrThrow;
    await this.modifierOrThrow(id);
    const branch = await this.prisma.scoped.branch.findFirst({ where: { id: branchId, deletedAt: null } });
    if (!branch) {
      throw new NotFoundException("Branch not found");
    }

    const setting = await this.prisma.scoped.modifierBranchSetting.upsert({
      where: { modifierId_branchId: { modifierId: id, branchId } },
      create: { tenantId, modifierId: id, branchId, isAvailable, createdBy: ctx.userId },
      update: { isAvailable, updatedBy: ctx.userId },
    });

    await this.audit.log({
      action: "modifier.branch_availability_updated",
      entityType: "modifier",
      entityId: id,
      branchId,
      meta: { isAvailable },
    });
    this.events.emit(DOMAIN_EVENTS.PRODUCT_AVAILABILITY_CHANGED, {
      tenantId,
      branchId,
      modifierId: id,
      isAvailable,
    });
    return setting;
  }

  private async groupOrThrow(id: string) {
    const group = await this.prisma.scoped.modifierGroup.findFirst({
      where: { id, deletedAt: null },
    });
    if (!group) {
      throw new NotFoundException("Modifier group not found");
    }
    return group;
  }

  private async modifierOrThrow(id: string) {
    const modifier = await this.prisma.scoped.modifier.findFirst({
      where: { id, deletedAt: null },
    });
    if (!modifier) {
      throw new NotFoundException("Modifier not found");
    }
    return modifier;
  }
}
