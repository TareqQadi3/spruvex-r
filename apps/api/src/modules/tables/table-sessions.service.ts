import { ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";

import { AuditService } from "../../shared/audit/audit.service";
import { halalasToSar, sarToHalalas } from "../../shared/common/money";
import { PlatformPrismaService } from "../../shared/prisma/platform-prisma.service";
import { PrismaService } from "../../shared/prisma/prisma.service";
import { GUEST_ACTOR, TenantContextService } from "../../shared/tenancy/tenant-context.service";

const ACTIVE_ORDER_STATUSES = ["new", "confirmed", "preparing", "ready", "served"] as const;

/** Real-world tuning: long enough to cover a full sit-down meal, short
 * enough that an abandoned/forgotten table doesn't sit "occupied" all day. */
const SESSION_INACTIVITY_TIMEOUT_MS = 90 * 60 * 1000;
const STALE_POLL_INTERVAL_MS = 2 * 60 * 1000;

/**
 * Table sessions — everyone seated at a table, sharing ONE real order. A
 * session represents customers seated at a table; every order/append from
 * the same table joins the open session's active order (see
 * `OrderingService.orderForTable`) and the whole visit closes as one bill.
 */
@Injectable()
export class TableSessionsService {
  private readonly logger = new Logger(TableSessionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly platformDb: PlatformPrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
  ) {}

  /** Opens a session and marks the table occupied. One open session per table. */
  async open(tableId: string, notes?: string) {
    const ctx = this.tenantContext.contextOrThrow;
    const table = await this.tableOrThrow(tableId);
    if (table.status === "disabled") {
      throw new ConflictException("Table is disabled");
    }

    const existing = await this.prisma.scoped.tableSession.findFirst({
      where: { tableId, closedAt: null },
    });
    if (existing) {
      throw new ConflictException("Table already has an open session");
    }

    const [session] = await Promise.all([
      this.prisma.scoped.tableSession.create({
        data: {
          tenantId: this.tenantContext.tenantIdOrThrow,
          branchId: table.branchId,
          tableId,
          openedBy: ctx.userId,
          notes,
        },
      }),
      this.prisma.scoped.table.update({
        where: { id: tableId },
        data: { status: "occupied", updatedBy: ctx.userId },
      }),
    ]);

    await this.audit.log({
      action: "table_session.opened",
      entityType: "table_session",
      entityId: session.id,
      branchId: table.branchId,
      meta: { tableNumber: table.number },
    });
    return session;
  }

  /**
   * Closes the open session and frees the table. Refuses to close over an
   * unpaid balance unless `force` is set — never silently drop a table's
   * outstanding bill just because the cashier hit close.
   */
  async close(tableId: string, opts: { force?: boolean } = {}) {
    const ctx = this.tenantContext.contextOrThrow;
    const table = await this.tableOrThrow(tableId);

    const session = await this.prisma.scoped.tableSession.findFirst({
      where: { tableId, closedAt: null },
    });
    if (!session) {
      throw new NotFoundException("No open session for this table");
    }

    const unpaidHalalas = await this.unpaidBalanceHalalas(session.id);
    if (unpaidHalalas > 0 && !opts.force) {
      throw new ConflictException(
        `This table has an unpaid balance of ${halalasToSar(unpaidHalalas)} SAR — confirm to close anyway`,
      );
    }

    const [closed] = await Promise.all([
      this.prisma.scoped.tableSession.update({
        where: { id: session.id },
        data: { closedAt: new Date(), closedBy: ctx.userId, staleFlaggedAt: null },
      }),
      this.prisma.scoped.table.update({
        where: { id: tableId },
        data: { status: "available", updatedBy: ctx.userId },
      }),
    ]);

    await this.audit.log({
      action: "table_session.closed",
      entityType: "table_session",
      entityId: session.id,
      branchId: table.branchId,
      meta: { tableNumber: table.number, unpaidBalance: halalasToSar(unpaidHalalas), forced: unpaidHalalas > 0 },
    });
    return closed;
  }

  /** Every currently open session for the cashier's "open tables" view. */
  async listOpen(branchId?: string) {
    const sessions = await this.prisma.scoped.tableSession.findMany({
      where: { closedAt: null, ...(branchId ? { branchId } : {}) },
      orderBy: { openedAt: "asc" },
      include: {
        table: { select: { id: true, number: true } },
        participants: {
          orderBy: { joinedAt: "asc" },
          select: { phone: true, name: true, joinedAt: true },
        },
      },
    });

    return Promise.all(
      sessions.map(async (session) => {
        const order = await this.prisma.scoped.order.findFirst({
          where: { tableSessionId: session.id, deletedAt: null },
          orderBy: { createdAt: "desc" },
          select: { id: true, orderNumber: true, status: true, total: true },
        });
        const unpaidHalalas = order ? await this.unpaidBalanceHalalas(session.id, order) : 0;
        return {
          sessionId: session.id,
          table: session.table,
          openedAt: session.openedAt,
          lastActivityAt: session.lastActivityAt,
          staleFlaggedAt: session.staleFlaggedAt,
          participants: session.participants,
          order: order
            ? { id: order.id, orderNumber: order.orderNumber, status: order.status, total: order.total.toString() }
            : null,
          unpaidBalance: halalasToSar(unpaidHalalas),
        };
      }),
    );
  }

  /**
   * Inactivity sweep: never silently closes a session with money still
   * owed — it only flags it for the cashier's open-sessions view to
   * surface. Only auto-closes sessions that are either fully settled or
   * never produced an order at all (an abandoned scan). Single-process
   * in-memory timer (same documented limitation as FeedbackService's
   * poller — a second API replica would need a distributed lock).
   */
  @Interval(STALE_POLL_INTERVAL_MS)
  async checkStaleSessions(): Promise<void> {
    const cutoff = new Date(Date.now() - SESSION_INACTIVITY_TIMEOUT_MS);
    const stale = await this.platformDb.tableSession.findMany({
      where: { closedAt: null, lastActivityAt: { lte: cutoff } },
      select: { id: true, tenantId: true, branchId: true, tableId: true, staleFlaggedAt: true },
    });

    for (const session of stale) {
      try {
        const order = await this.platformDb.order.findFirst({
          where: { tableSessionId: session.id, deletedAt: null },
          orderBy: { createdAt: "desc" },
        });
        const unpaidHalalas = order ? await this.unpaidBalanceHalalasAdmin(session.id, order) : 0;

        if (unpaidHalalas > 0) {
          if (!session.staleFlaggedAt) {
            await this.platformDb.tableSession.update({
              where: { id: session.id },
              data: { staleFlaggedAt: new Date() },
            });
            await this.tenantContext.run(
              { userId: GUEST_ACTOR, tenantId: session.tenantId, branchId: session.branchId, permissions: new Set() },
              () =>
                this.audit.log({
                  action: "table_session.flagged_stale",
                  entityType: "table_session",
                  entityId: session.id,
                  branchId: session.branchId,
                  meta: { unpaidBalance: halalasToSar(unpaidHalalas) },
                }),
            );
          }
          continue;
        }

        // Fully settled (or never ordered) and inactive — safe to auto-close.
        await this.platformDb.tableSession.update({
          where: { id: session.id },
          data: { closedAt: new Date(), staleFlaggedAt: null },
        });
        await this.platformDb.table.update({
          where: { id: session.tableId },
          data: { status: "available" },
        });
        await this.tenantContext.run(
          { userId: GUEST_ACTOR, tenantId: session.tenantId, branchId: session.branchId, permissions: new Set() },
          () =>
            this.audit.log({
              action: "table_session.auto_closed",
              entityType: "table_session",
              entityId: session.id,
              branchId: session.branchId,
              meta: { reason: "inactivity_timeout" },
            }),
        );
      } catch (error) {
        this.logger.warn(`Stale-session check failed for session ${session.id}: ${(error as Error).message}`);
      }
    }
  }

  private async unpaidBalanceHalalas(
    sessionId: string,
    knownOrder?: { id: string; status: string; total: { toString(): string } },
  ): Promise<number> {
    const order =
      knownOrder ??
      (await this.prisma.scoped.order.findFirst({
        where: { tableSessionId: sessionId, deletedAt: null },
        orderBy: { createdAt: "desc" },
      }));
    if (!order || !(ACTIVE_ORDER_STATUSES as readonly string[]).includes(order.status)) return 0;
    const paid = await this.prisma.scoped.payment.aggregate({
      where: { orderId: order.id, status: "completed" },
      _sum: { amount: true },
    });
    const paidHalalas = sarToHalalas((paid._sum.amount ?? 0).toString());
    const totalHalalas = sarToHalalas(order.total.toString());
    return Math.max(0, totalHalalas - paidHalalas);
  }

  /** Same as `unpaidBalanceHalalas` but via the admin connection, for the cross-tenant poller. */
  private async unpaidBalanceHalalasAdmin(
    sessionId: string,
    order: { id: string; status: string; total: { toString(): string } },
  ): Promise<number> {
    if (!(ACTIVE_ORDER_STATUSES as readonly string[]).includes(order.status)) return 0;
    const paid = await this.platformDb.payment.aggregate({
      where: { orderId: order.id, status: "completed" },
      _sum: { amount: true },
    });
    const paidHalalas = sarToHalalas((paid._sum.amount ?? 0).toString());
    const totalHalalas = sarToHalalas(order.total.toString());
    return Math.max(0, totalHalalas - paidHalalas);
  }

  private async tableOrThrow(tableId: string) {
    const table = await this.prisma.scoped.table.findFirst({
      where: { id: tableId, deletedAt: null },
    });
    if (!table) {
      throw new NotFoundException("Table not found");
    }
    return table;
  }
}
