import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";

import { DOMAIN_EVENTS } from "@spruvex-r/types";

import { AuditService } from "../../shared/audit/audit.service";
import { halalasToSar, sarToHalalas } from "../../shared/common/money";
import { PrismaService } from "../../shared/prisma/prisma.service";
import { TenantContextService } from "../../shared/tenancy/tenant-context.service";
import { CloseShiftDto, OpenShiftDto } from "./dto/shifts.dto";

@Injectable()
export class ShiftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
  ) {}

  /** The caller's open shift in a branch (POS boot / payment precondition). */
  current(branchId: string) {
    const ctx = this.tenantContext.contextOrThrow;
    return this.prisma.scoped.shift.findFirst({
      where: { branchId, openedBy: ctx.userId, closedAt: null },
    });
  }

  list(branchId?: string) {
    return this.prisma.scoped.shift.findMany({
      where: { ...(branchId ? { branchId } : {}) },
      orderBy: { openedAt: "desc" },
      take: 50,
    });
  }

  async open(dto: OpenShiftDto) {
    const ctx = this.tenantContext.contextOrThrow;

    const branch = await this.prisma.scoped.branch.findFirst({
      where: { id: dto.branchId, deletedAt: null },
    });
    if (!branch) {
      throw new NotFoundException("Branch not found");
    }
    const existing = await this.current(dto.branchId);
    if (existing) {
      throw new ConflictException("You already have an open shift in this branch");
    }

    const shift = await this.prisma.scoped.shift.create({
      data: {
        tenantId: this.tenantContext.tenantIdOrThrow,
        branchId: dto.branchId,
        openedBy: ctx.userId,
        openingCash: dto.openingCash,
      },
    });
    await this.audit.log({
      action: "shift.opened",
      entityType: "shift",
      entityId: shift.id,
      branchId: dto.branchId,
      meta: { openingCash: dto.openingCash },
    });
    this.events.emit(DOMAIN_EVENTS.SHIFT_OPENED, {
      tenantId: shift.tenantId,
      branchId: dto.branchId,
      shiftId: shift.id,
    });
    return shift;
  }

  /**
   * Close foundation: expected cash = opening float + completed cash
   * payments taken during the shift - cash refunds processed during the
   * shift. Full reconciliation reporting lands in Phase 8.
   */
  async close(id: string, dto: CloseShiftDto) {
    const ctx = this.tenantContext.contextOrThrow;

    const shift = await this.prisma.scoped.shift.findFirst({ where: { id } });
    if (!shift) {
      throw new NotFoundException("Shift not found");
    }
    if (shift.closedAt) {
      throw new ConflictException("Shift is already closed");
    }

    const [cashPayments, cashRefunds] = await Promise.all([
      this.prisma.scoped.payment.findMany({
        where: { shiftId: id, method: "cash", status: "completed" },
        select: { amount: true },
      }),
      // Refunds are posted to whichever shift is OPEN when they're
      // processed (refunds.service.ts) — never a retroactive edit of the
      // shift the original payment belonged to — so cash handed back
      // during THIS shift reduces THIS shift's expected cash.
      this.prisma.scoped.refund.findMany({
        where: { shiftId: id, method: "cash" },
        select: { amount: true },
      }),
    ]);
    const expectedHalalas =
      sarToHalalas(shift.openingCash.toString()) +
      cashPayments.reduce((sum, p) => sum + sarToHalalas(p.amount.toString()), 0) -
      cashRefunds.reduce((sum, r) => sum + sarToHalalas(r.amount.toString()), 0);
    const expectedCash = halalasToSar(expectedHalalas);
    const difference =
      dto.actualCash !== undefined
        ? halalasToSar(sarToHalalas(dto.actualCash) - expectedHalalas)
        : null;

    const closed = await this.prisma.scoped.shift.update({
      where: { id },
      data: {
        closedAt: new Date(),
        closedBy: ctx.userId,
        expectedCash,
        actualCash: dto.actualCash ?? null,
        difference,
      },
    });
    await this.audit.log({
      action: "shift.closed",
      entityType: "shift",
      entityId: id,
      branchId: shift.branchId,
      meta: { expectedCash, actualCash: dto.actualCash ?? null, difference },
    });
    this.events.emit(DOMAIN_EVENTS.SHIFT_CLOSED, {
      tenantId: shift.tenantId,
      branchId: shift.branchId,
      shiftId: id,
    });
    return closed;
  }
}
