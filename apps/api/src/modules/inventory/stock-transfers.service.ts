import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { AuditService } from "../../shared/audit/audit.service";
import { PrismaService } from "../../shared/prisma/prisma.service";
import { actorOrNull, TenantContextService } from "../../shared/tenancy/tenant-context.service";
import {
  CancelStockTransferDto,
  CreateStockTransferDto,
  ListStockTransfersQueryDto,
  ReceiveStockTransferDto,
  RejectStockTransferDto,
} from "./dto/stock-transfer.dto";
import { InventoryService } from "./inventory.service";

const TRANSFER_INCLUDE = { items: { orderBy: { createdAt: "asc" } } } satisfies Prisma.StockTransferInclude;

type TransferWithItems = Prisma.StockTransferGetPayload<{ include: typeof TRANSFER_INCLUDE }>;

/**
 * Inter-branch stock transfer — the state machine deliberately kept as one
 * open enum (StockTransferStatus) rather than scattered booleans, so a
 * future intermediate state (e.g. courier "in_transit" tracking) is one
 * more enum value and one more branch here, not a redesign:
 *
 *   draft --send()--> sent --receive()--> received   (terminal)
 *     |                 \--reject()-----> rejected    (terminal)
 *     \--cancel()------> cancelled                    (terminal)
 *
 * A "sent" transfer can never be cancelled — the goods already left the
 * source branch's books (see send()'s doc comment on why that state must
 * exist at all); the only ways out of "sent" are receive() or reject(),
 * both of which resolve where the goods actually ended up. Every
 * transition row-locks the transfer first (same `SELECT ... FOR UPDATE`
 * pattern as PurchasesService.confirm/cancel), so two concurrent requests
 * against the same transfer resolve to one success and a clean 409, never
 * a double-post.
 */
@Injectable()
export class StockTransfersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
    private readonly inventory: InventoryService,
  ) {}

  list(query: ListStockTransfersQueryDto) {
    return this.prisma.scoped.stockTransfer.findMany({
      where: {
        deletedAt: null,
        ...(query.branchId ? { OR: [{ fromBranchId: query.branchId }, { toBranchId: query.branchId }] } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      include: TRANSFER_INCLUDE,
      orderBy: { createdAt: "desc" },
    });
  }

  async get(id: string) {
    const transfer = await this.prisma.scoped.stockTransfer.findFirst({
      where: { id, deletedAt: null },
      include: TRANSFER_INCLUDE,
    });
    if (!transfer) {
      throw new NotFoundException("Stock transfer not found");
    }
    return transfer;
  }

  /** Draft only — no stock movement happens until send(). */
  async create(dto: CreateStockTransferDto) {
    const ctx = this.tenantContext.contextOrThrow;
    const tenantId = this.tenantContext.tenantIdOrThrow;
    const actor = actorOrNull(ctx.userId);

    if (dto.fromBranchId === dto.toBranchId) {
      throw new BadRequestException("A transfer's source and destination branch must be different");
    }

    const [fromBranch, toBranch] = await Promise.all([
      this.prisma.scoped.branch.findFirst({ where: { id: dto.fromBranchId, deletedAt: null } }),
      this.prisma.scoped.branch.findFirst({ where: { id: dto.toBranchId, deletedAt: null } }),
    ]);
    if (!fromBranch) throw new NotFoundException("Source branch not found");
    if (!toBranch) throw new NotFoundException("Destination branch not found");

    const ingredientIds = [...new Set(dto.items.map((i) => i.ingredientId))];
    const found = await this.prisma.scoped.ingredient.findMany({
      where: { id: { in: ingredientIds }, deletedAt: null },
      select: { id: true },
    });
    if (found.length !== ingredientIds.length) {
      throw new NotFoundException("One or more ingredients were not found");
    }

    const transfer = await this.prisma.scopedTransaction(async (tx) => {
      const resolvedItems = await Promise.all(
        dto.items.map(async (item) => ({
          tenantId,
          ingredientId: item.ingredientId,
          fromLocationId: await this.inventory.resolveLocationId(tx, dto.fromBranchId, item.fromLocationId),
          sentQuantity: item.quantity,
        })),
      );

      return tx.stockTransfer.create({
        data: {
          tenantId,
          fromBranchId: dto.fromBranchId,
          toBranchId: dto.toBranchId,
          notes: dto.notes,
          createdBy: actor,
          items: { create: resolvedItems },
        },
        include: TRANSFER_INCLUDE,
      });
    });

    await this.audit.log({
      action: "stock_transfer.created",
      entityType: "stock_transfer",
      entityId: transfer.id,
      branchId: transfer.fromBranchId,
      meta: { toBranchId: transfer.toBranchId, itemCount: transfer.items.length },
    });
    return transfer;
  }

  /**
   * draft -> sent. Posts a real transfer_out movement per line NOW — the
   * whole point of a separate send() step: goods physically leaving the
   * source branch is a real, immediate inventory event, not something to
   * defer until someone eventually confirms receipt. Freezes each item's
   * unitCostAtSend (the ingredient's current average cost) so a purchase
   * elsewhere between send and receive can never retroactively change what
   * this transfer is valued at — same principle as a purchase invoice
   * line's frozen unitPrice.
   *
   * Any line refusing (insufficient stock) rolls back every line already
   * posted in this same call — a transfer either fully leaves the source
   * branch or not at all, never half of it.
   */
  async send(id: string) {
    const ctx = this.tenantContext.contextOrThrow;
    const actor = actorOrNull(ctx.userId);

    const transfer = await this.prisma.scopedTransaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM stock_transfers WHERE id = ${id}::uuid FOR UPDATE
      `;
      if (locked.length === 0) {
        throw new NotFoundException("Stock transfer not found");
      }
      const current = await this.currentOrThrow(tx, id);
      if (current.status !== "draft") {
        throw new ConflictException(`Transfer is already ${current.status}`);
      }

      for (const item of current.items) {
        const ingredient = await this.inventory.ingredientOrThrow(tx, item.ingredientId);
        await this.inventory.recordTransferOut(
          {
            branchId: current.fromBranchId,
            locationId: item.fromLocationId,
            ingredientId: item.ingredientId,
            quantity: item.sentQuantity.toString(),
          },
          { referenceType: "stock_transfer_item_send", referenceId: item.id, tx },
        );
        await tx.stockTransferItem.update({
          where: { id: item.id },
          data: { unitCostAtSend: ingredient.averageCost },
        });
      }

      return tx.stockTransfer.update({
        where: { id },
        data: { status: "sent", sentAt: new Date(), sentBy: actor, updatedBy: actor },
        include: TRANSFER_INCLUDE,
      });
    });

    await this.audit.log({
      action: "stock_transfer.sent",
      entityType: "stock_transfer",
      entityId: transfer.id,
      branchId: transfer.fromBranchId,
      meta: { toBranchId: transfer.toBranchId, itemCount: transfer.items.length },
    });
    return transfer;
  }

  /**
   * sent -> received. Every item must be accounted for explicitly (the
   * destination branch counts what actually arrived, not what was
   * expected) — a mandatory discrepancyReason kicks in wherever
   * receivedQuantity < sentQuantity, same "never a silent gap" principle
   * as every reversal/waste elsewhere in this codebase. The un-received
   * remainder is never posted as transfer_in at all — it's a genuine loss,
   * recorded here as data rather than fabricated into a synthetic
   * secondary movement.
   */
  async receive(id: string, dto: ReceiveStockTransferDto) {
    const ctx = this.tenantContext.contextOrThrow;
    const actor = actorOrNull(ctx.userId);

    const transfer = await this.prisma.scopedTransaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM stock_transfers WHERE id = ${id}::uuid FOR UPDATE
      `;
      if (locked.length === 0) {
        throw new NotFoundException("Stock transfer not found");
      }
      const current = await this.currentOrThrow(tx, id);
      if (current.status !== "sent") {
        throw new ConflictException(`Transfer is ${current.status} — only a sent transfer can be received`);
      }

      const submittedIds = new Set(dto.items.map((i) => i.stockTransferItemId));
      if (submittedIds.size !== current.items.length || current.items.some((i) => !submittedIds.has(i.id))) {
        throw new BadRequestException("Every line of this transfer must be accounted for in the receive request");
      }

      for (const submitted of dto.items) {
        const item = current.items.find((i) => i.id === submitted.stockTransferItemId)!;
        const receivedQty = Number(submitted.receivedQuantity);
        const sentQty = Number(item.sentQuantity);
        if (receivedQty > sentQty) {
          throw new BadRequestException(
            `Received quantity (${submitted.receivedQuantity}) cannot exceed the sent quantity (${item.sentQuantity.toString()}) for this line`,
          );
        }
        if (receivedQty < sentQty && !submitted.discrepancyReason?.trim()) {
          throw new BadRequestException(
            `A reason is required: received quantity (${submitted.receivedQuantity}) is less than sent (${item.sentQuantity.toString()}) for this line`,
          );
        }

        const toLocationId = await this.inventory.resolveLocationId(tx, current.toBranchId, submitted.toLocationId);
        if (receivedQty > 0) {
          await this.inventory.recordTransferReceipt(
            {
              branchId: current.toBranchId,
              locationId: toLocationId,
              ingredientId: item.ingredientId,
              quantity: submitted.receivedQuantity,
              unitCostSar: item.unitCostAtSend!.toString(),
            },
            { referenceType: "stock_transfer_item_receive", referenceId: item.id, tx },
          );
        }

        await tx.stockTransferItem.update({
          where: { id: item.id },
          data: {
            toLocationId,
            receivedQuantity: submitted.receivedQuantity,
            discrepancyReason: receivedQty < sentQty ? submitted.discrepancyReason : null,
          },
        });
      }

      return tx.stockTransfer.update({
        where: { id },
        data: {
          status: "received",
          receivedAt: new Date(),
          receivedBy: actor,
          updatedBy: actor,
        },
        include: TRANSFER_INCLUDE,
      });
    });

    await this.audit.log({
      action: "stock_transfer.received",
      entityType: "stock_transfer",
      entityId: transfer.id,
      branchId: transfer.toBranchId,
      meta: {
        fromBranchId: transfer.fromBranchId,
        items: transfer.items.map((i) => ({
          ingredientId: i.ingredientId,
          sentQuantity: i.sentQuantity.toString(),
          receivedQuantity: i.receivedQuantity?.toString(),
          discrepancyReason: i.discrepancyReason,
        })),
      },
    });
    return transfer;
  }

  /**
   * sent -> rejected. The destination declines the shipment outright — the
   * full sent quantity of every line returns to the ORIGIN branch (the
   * same recordTransferReceipt used for a genuine receive, just pointed
   * back at fromBranch/fromLocationId with the same frozen unitCostAtSend),
   * which mathematically restores exactly the pre-send stock level and
   * average cost. A rejection is a distinct, separately-reportable outcome
   * from a plain cancel() — the goods DID leave, then came back — so it is
   * its own terminal status, not folded into "cancelled".
   */
  async reject(id: string, dto: RejectStockTransferDto) {
    const ctx = this.tenantContext.contextOrThrow;
    const actor = actorOrNull(ctx.userId);

    const transfer = await this.prisma.scopedTransaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM stock_transfers WHERE id = ${id}::uuid FOR UPDATE
      `;
      if (locked.length === 0) {
        throw new NotFoundException("Stock transfer not found");
      }
      const current = await this.currentOrThrow(tx, id);
      if (current.status !== "sent") {
        throw new ConflictException(`Transfer is ${current.status} — only a sent transfer can be rejected`);
      }

      for (const item of current.items) {
        await this.inventory.recordTransferReceipt(
          {
            branchId: current.fromBranchId,
            locationId: item.fromLocationId,
            ingredientId: item.ingredientId,
            quantity: item.sentQuantity.toString(),
            unitCostSar: item.unitCostAtSend!.toString(),
          },
          { referenceType: "stock_transfer_item_reject", referenceId: item.id, tx },
        );
      }

      return tx.stockTransfer.update({
        where: { id },
        data: {
          status: "rejected",
          rejectedAt: new Date(),
          rejectedBy: actor,
          rejectReason: dto.reason,
          updatedBy: actor,
        },
        include: TRANSFER_INCLUDE,
      });
    });

    await this.audit.log({
      action: "stock_transfer.rejected",
      entityType: "stock_transfer",
      entityId: transfer.id,
      branchId: transfer.toBranchId,
      meta: { fromBranchId: transfer.fromBranchId, reason: dto.reason },
    });
    return transfer;
  }

  /** draft -> cancelled only. Nothing was ever posted, so this is a pure metadata flip. */
  async cancel(id: string, dto: CancelStockTransferDto) {
    const ctx = this.tenantContext.contextOrThrow;
    const actor = actorOrNull(ctx.userId);

    const transfer = await this.prisma.scopedTransaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM stock_transfers WHERE id = ${id}::uuid FOR UPDATE
      `;
      if (locked.length === 0) {
        throw new NotFoundException("Stock transfer not found");
      }
      const current = await this.currentOrThrow(tx, id);
      if (current.status !== "draft") {
        throw new ConflictException(
          `Only a draft transfer can be cancelled (this one is ${current.status}) — a sent transfer must be received or rejected instead`,
        );
      }

      return tx.stockTransfer.update({
        where: { id },
        data: {
          status: "cancelled",
          cancelledAt: new Date(),
          cancelledBy: actor,
          cancelReason: dto.reason,
          updatedBy: actor,
        },
        include: TRANSFER_INCLUDE,
      });
    });

    await this.audit.log({
      action: "stock_transfer.cancelled",
      entityType: "stock_transfer",
      entityId: transfer.id,
      branchId: transfer.fromBranchId,
      meta: { reason: dto.reason },
    });
    return transfer;
  }

  private async currentOrThrow(tx: Prisma.TransactionClient, id: string): Promise<TransferWithItems> {
    const current = await tx.stockTransfer.findFirst({
      where: { id, deletedAt: null },
      include: TRANSFER_INCLUDE,
    });
    if (!current) {
      throw new NotFoundException("Stock transfer not found");
    }
    return current;
  }
}
