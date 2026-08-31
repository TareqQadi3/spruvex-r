import { Injectable, NotFoundException } from "@nestjs/common";

import { AuditService } from "../../shared/audit/audit.service";
import { PrismaService } from "../../shared/prisma/prisma.service";
import { actorOrNull, TenantContextService } from "../../shared/tenancy/tenant-context.service";
import { CreateSupplierDto, UpdateSupplierDto } from "./dto/purchases.dto";

@Injectable()
export class SuppliersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
  ) {}

  list(includeInactive = false) {
    return this.prisma.scoped.supplier.findMany({
      where: { deletedAt: null, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: { name: "asc" },
    });
  }

  async get(id: string) {
    const supplier = await this.prisma.scoped.supplier.findFirst({ where: { id, deletedAt: null } });
    if (!supplier) {
      throw new NotFoundException("Supplier not found");
    }
    return supplier;
  }

  async create(dto: CreateSupplierDto) {
    const ctx = this.tenantContext.contextOrThrow;
    const actor = actorOrNull(ctx.userId);
    const supplier = await this.prisma.scoped.supplier.create({
      data: { tenantId: this.tenantContext.tenantIdOrThrow, ...dto, createdBy: actor },
    });
    await this.audit.log({
      action: "supplier.created",
      entityType: "supplier",
      entityId: supplier.id,
      meta: { name: supplier.name },
    });
    return supplier;
  }

  async update(id: string, dto: UpdateSupplierDto) {
    const ctx = this.tenantContext.contextOrThrow;
    const actor = actorOrNull(ctx.userId);
    await this.get(id);
    const supplier = await this.prisma.scoped.supplier.update({
      where: { id },
      data: { ...dto, updatedBy: actor },
    });
    await this.audit.log({
      action: "supplier.updated",
      entityType: "supplier",
      entityId: supplier.id,
      meta: { changes: { ...dto } },
    });
    return supplier;
  }
}
