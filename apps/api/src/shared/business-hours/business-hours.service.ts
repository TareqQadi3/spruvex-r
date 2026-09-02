import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { Interval } from "@nestjs/schedule";

import {
  ACTIVE_ORDER_STATUSES,
  DOMAIN_EVENTS,
  ORDERING_CHANNELS,
  resolveChannelOpenState,
  type BranchWorkingHours,
  type ChannelOpenState,
  type OrderingChannel,
} from "@spruvex-r/types";

import { PlatformPrismaService } from "../prisma/platform-prisma.service";
import { PrismaService } from "../prisma/prisma.service";
import { riyadhDateString } from "../common/riyadh-date";
import { actorOrNull, GUEST_ACTOR, TenantContextService } from "../tenancy/tenant-context.service";
import { AuditService } from "../audit/audit.service";
import type { PauseChannelDto, UpdateDeliverySettingsDto } from "./dto/business-hours.dto";
import { parseWorkingHours } from "./working-hours.validator";

const SYSTEM_ACTOR = GUEST_ACTOR;
const PAUSE_SWEEP_INTERVAL_MS = 60_000;
const SOLD_OUT_SWEEP_INTERVAL_MS = 5 * 60_000;
const AUTO_SLOWDOWN_SWEEP_INTERVAL_MS = 60_000;

export interface ChannelStatus extends ChannelOpenState {
  channel: OrderingChannel;
  pausedUntil: Date | null;
  pausedReason: string | null;
  systemBusy: boolean;
}

/**
 * Single source of truth for whether a self-service ordering channel is
 * open right now: the weekly schedule + exceptions (Branch.workingHours,
 * see working-hours.validator.ts for the shape) layered under an immediate
 * manual/system pause (BranchChannelPause). Consumed by:
 *   - GuestOrderingService / OrderingService.orderForTable via
 *     assertChannelOpen() at the moment an order is created — the real
 *     server-side enforcement the round's spec requires (never just a
 *     hidden button on the frontend).
 *   - TenancyController's hours/pause/delivery-settings endpoints.
 *   - The public menu endpoints, to render "closed until X" while still
 *     letting guests browse.
 *
 * POS orders (OrderType.walkin, and any type created via the `pos` source)
 * are NEVER subject to this — hours/pauses gate SELF-SERVICE ordering only;
 * a cashier can always ring up a walk-in or phone order regardless.
 */
@Injectable()
export class BusinessHoursService {
  private readonly logger = new Logger(BusinessHoursService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly platformDb: PlatformPrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
  ) {}

  // ------------------------------------------------------------------ //
  // Hours CRUD
  // ------------------------------------------------------------------ //

  async updateWorkingHours(branchId: string, raw: Record<string, unknown>) {
    const ctx = this.tenantContext.contextOrThrow;
    const parsed = parseWorkingHours(raw);
    const branch = await this.branchOrThrow(branchId);

    const updated = await this.prisma.scoped.branch.update({
      where: { id: branch.id },
      data: { workingHours: parsed as object, updatedBy: ctx.userId },
      select: { id: true, workingHours: true },
    });
    await this.audit.log({
      action: "branch.working_hours_updated",
      entityType: "branch",
      entityId: branchId,
      branchId,
      meta: { workingHours: parsed as object },
    });
    for (const channel of ORDERING_CHANNELS) {
      await this.broadcastStatus(this.tenantContext.tenantIdOrThrow, branchId, channel);
    }
    return updated;
  }

  // ------------------------------------------------------------------ //
  // Manual pause CRUD
  // ------------------------------------------------------------------ //

  async pauseChannel(branchId: string, dto: PauseChannelDto) {
    const ctx = this.tenantContext.contextOrThrow;
    const tenantId = this.tenantContext.tenantIdOrThrow;
    await this.branchOrThrow(branchId);

    const pausedUntil = dto.durationMinutes
      ? new Date(Date.now() + dto.durationMinutes * 60_000)
      : null;

    const pause = await this.prisma.scoped.branchChannelPause.upsert({
      where: { branchId_channel: { branchId, channel: dto.channel } },
      create: {
        tenantId,
        branchId,
        channel: dto.channel,
        reason: dto.reason ?? null,
        pausedUntil,
        pausedBy: actorOrNull(ctx.userId),
      },
      update: {
        reason: dto.reason ?? null,
        pausedUntil,
        pausedBy: actorOrNull(ctx.userId),
        pausedAt: new Date(),
      },
    });

    await this.audit.log({
      action: "branch.channel_paused",
      entityType: "branch",
      entityId: branchId,
      branchId,
      meta: { channel: dto.channel, reason: dto.reason ?? null, pausedUntil },
    });
    await this.broadcastStatus(tenantId, branchId, dto.channel);
    return pause;
  }

  async resumeChannel(branchId: string, channel: OrderingChannel) {
    const tenantId = this.tenantContext.tenantIdOrThrow;
    await this.branchOrThrow(branchId);
    await this.prisma.scoped.branchChannelPause.deleteMany({ where: { branchId, channel } });

    await this.audit.log({
      action: "branch.channel_resumed",
      entityType: "branch",
      entityId: branchId,
      branchId,
      meta: { channel },
    });
    await this.broadcastStatus(tenantId, branchId, channel);
    return { resumed: true };
  }

  // ------------------------------------------------------------------ //
  // Resolution
  // ------------------------------------------------------------------ //

  async getChannelStatus(branchId: string, channel: OrderingChannel): Promise<ChannelStatus> {
    const branch = await this.prisma.scoped.branch.findFirst({
      where: { id: branchId, deletedAt: null },
      select: { workingHours: true, autoSlowdownThreshold: true },
    });
    if (!branch) {
      throw new NotFoundException("Branch not found");
    }
    const pause = await this.prisma.scoped.branchChannelPause.findUnique({
      where: { branchId_channel: { branchId, channel } },
    });
    const systemBusy = await this.isSystemBusy(branchId, branch.autoSlowdownThreshold);

    if (pause) {
      return {
        channel,
        open: false,
        reason: "paused",
        label: pause.reason ?? undefined,
        pausedUntil: pause.pausedUntil,
        pausedReason: pause.reason,
        systemBusy,
      };
    }

    const resolved = resolveChannelOpenState(
      branch.workingHours as BranchWorkingHours,
      channel,
      Date.now(),
    );
    return { channel, ...resolved, pausedUntil: null, pausedReason: null, systemBusy };
  }

  async listChannelStatuses(branchId: string): Promise<ChannelStatus[]> {
    return Promise.all(ORDERING_CHANNELS.map((channel) => this.getChannelStatus(branchId, channel)));
  }

  /** Throws ConflictException when `channel` is not open right now — the real server-side gate. */
  async assertChannelOpen(branchId: string, channel: OrderingChannel): Promise<void> {
    const status = await this.getChannelStatus(branchId, channel);
    if (!status.open) {
      const suffix = status.label ? ` — ${status.label}` : "";
      throw new ConflictException(`This ordering channel is currently closed${suffix}`);
    }
  }

  private async broadcastStatus(tenantId: string, branchId: string, channel: OrderingChannel) {
    const status = await this.getChannelStatus(branchId, channel);
    this.events.emit(DOMAIN_EVENTS.BRANCH_CHANNEL_STATUS_CHANGED, {
      tenantId,
      branchId,
      channel,
      open: status.open,
      reason: status.reason,
    });
  }

  // ------------------------------------------------------------------ //
  // Delivery/pickup settings
  // ------------------------------------------------------------------ //

  async updateDeliverySettings(branchId: string, dto: UpdateDeliverySettingsDto) {
    const ctx = this.tenantContext.contextOrThrow;
    await this.branchOrThrow(branchId);

    if (dto.autoPauseThreshold != null && dto.autoSlowdownThreshold != null) {
      if (dto.autoPauseThreshold <= dto.autoSlowdownThreshold) {
        throw new BadRequestException(
          "autoPauseThreshold must be greater than autoSlowdownThreshold",
        );
      }
    }

    const branch = await this.prisma.scoped.branch.update({
      where: { id: branchId },
      data: {
        ...(dto.deliveryFeeAmount !== undefined ? { deliveryFeeAmount: dto.deliveryFeeAmount } : {}),
        ...(dto.deliveryMinOrderAmount !== undefined
          ? { deliveryMinOrderAmount: dto.deliveryMinOrderAmount }
          : {}),
        ...(dto.deliveryRadiusKm !== undefined ? { deliveryRadiusKm: dto.deliveryRadiusKm } : {}),
        ...(dto.deliveryEstimatedMinutes !== undefined
          ? { deliveryEstimatedMinutes: dto.deliveryEstimatedMinutes }
          : {}),
        ...(dto.pickupEstimatedMinutes !== undefined
          ? { pickupEstimatedMinutes: dto.pickupEstimatedMinutes }
          : {}),
        ...(dto.selfServicePaymentMethods !== undefined
          ? { selfServicePaymentMethods: dto.selfServicePaymentMethods as object }
          : {}),
        ...(dto.autoSlowdownThreshold !== undefined
          ? { autoSlowdownThreshold: dto.autoSlowdownThreshold }
          : {}),
        ...(dto.autoPauseThreshold !== undefined ? { autoPauseThreshold: dto.autoPauseThreshold } : {}),
        updatedBy: ctx.userId,
      },
    });
    await this.audit.log({
      action: "branch.delivery_settings_updated",
      entityType: "branch",
      entityId: branchId,
      branchId,
      meta: { changes: { ...dto } },
    });
    return branch;
  }

  /** Haversine distance in km between two lat/lng pairs. */
  static distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // ------------------------------------------------------------------ //
  // Auto-slowdown (item 4) — busy flag + system auto-pause
  // ------------------------------------------------------------------ //

  private async isSystemBusy(branchId: string, autoSlowdownThreshold: number | null): Promise<boolean> {
    if (!autoSlowdownThreshold) return false;
    const pending = await this.prisma.scoped.order.count({
      where: { branchId, deletedAt: null, status: { in: [...ACTIVE_ORDER_STATUSES] } },
    });
    return pending >= autoSlowdownThreshold;
  }

  /**
   * Single-process in-memory timer (same documented limitation as
   * FeedbackService/TableSessionsService's pollers — a second API replica
   * would need a distributed lock). Runs across every tenant/branch via
   * platformDb, entering each branch's own tenant context only to perform
   * the actual write + audit log.
   */
  @Interval(AUTO_SLOWDOWN_SWEEP_INTERVAL_MS)
  async sweepAutoPause(): Promise<void> {
    const branches = await this.platformDb.branch.findMany({
      where: { deletedAt: null, autoPauseThreshold: { not: null } },
      select: { id: true, tenantId: true, autoPauseThreshold: true },
    });

    for (const branch of branches) {
      try {
        const pending = await this.platformDb.order.count({
          where: {
            branchId: branch.id,
            deletedAt: null,
            status: { in: [...ACTIVE_ORDER_STATUSES] },
          },
        });
        if (pending < (branch.autoPauseThreshold ?? Infinity)) continue;

        await this.tenantContext.run(
          { userId: SYSTEM_ACTOR, tenantId: branch.tenantId, permissions: new Set() },
          async () => {
            // Only delivery/takeaway are throttled — dine-in guests are
            // already seated and still need to be served regardless of
            // incoming-order pressure.
            for (const channel of ["delivery", "takeaway"] as const) {
              const existing = await this.prisma.scoped.branchChannelPause.findUnique({
                where: { branchId_channel: { branchId: branch.id, channel } },
              });
              if (existing) continue; // don't clobber a human's own pause/reason
              await this.pauseChannel(branch.id, {
                channel,
                reason: "Auto-paused: too many pending orders",
                durationMinutes: 15,
              });
            }
          },
        );
      } catch (error) {
        this.logger.error(`Auto-pause sweep failed for branch ${branch.id}: ${(error as Error).message}`);
      }
    }
  }

  @Interval(PAUSE_SWEEP_INTERVAL_MS)
  async sweepExpiredPauses(): Promise<void> {
    const expired = await this.platformDb.branchChannelPause.findMany({
      where: { pausedUntil: { lte: new Date() } },
      select: { id: true, tenantId: true, branchId: true, channel: true },
    });
    for (const pause of expired) {
      try {
        await this.tenantContext.run(
          { userId: SYSTEM_ACTOR, tenantId: pause.tenantId, permissions: new Set() },
          () => this.resumeChannel(pause.branchId, pause.channel),
        );
      } catch (error) {
        this.logger.error(`Pause sweep failed for ${pause.id}: ${(error as Error).message}`);
      }
    }
  }

  @Interval(SOLD_OUT_SWEEP_INTERVAL_MS)
  async sweepSoldOutToday(): Promise<void> {
    const today = riyadhDateString();
    const stale = await this.platformDb.productBranchSetting.findMany({
      where: { unavailableReason: "sold_out_today", soldOutDate: { lt: new Date(today) } },
      select: { id: true, tenantId: true, branchId: true, productId: true },
    });
    for (const row of stale) {
      try {
        await this.tenantContext.run(
          { userId: SYSTEM_ACTOR, tenantId: row.tenantId, permissions: new Set() },
          async () => {
            await this.prisma.scoped.productBranchSetting.update({
              where: { id: row.id },
              data: { isAvailable: true, unavailableReason: null, soldOutDate: null },
            });
            await this.audit.log({
              action: "product.availability_state_changed",
              entityType: "product",
              entityId: row.productId,
              branchId: row.branchId,
              meta: { isAvailable: true, reason: "sold_out_today_expired" },
            });
            this.events.emit(DOMAIN_EVENTS.PRODUCT_AVAILABILITY_CHANGED, {
              tenantId: row.tenantId,
              branchId: row.branchId,
              productId: row.productId,
              isAvailable: true,
            });
          },
        );
      } catch (error) {
        this.logger.error(`Sold-out-today sweep failed for ${row.id}: ${(error as Error).message}`);
      }
    }
  }

  private async branchOrThrow(branchId: string) {
    const branch = await this.prisma.scoped.branch.findFirst({ where: { id: branchId, deletedAt: null } });
    if (!branch) {
      throw new NotFoundException("Branch not found");
    }
    return branch;
  }
}
