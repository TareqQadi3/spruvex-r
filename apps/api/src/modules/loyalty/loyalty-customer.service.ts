import { ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";

import {
  type LoyaltyProgramType,
  type PointsPerRiyalConfig,
  type SpendThresholdConfig,
  type StampCardConfig,
  type TierConfig,
} from "@spruvex-r/types";

import { AuditService } from "../../shared/audit/audit.service";
import { halalasToSar, sarToHalalas } from "../../shared/common/money";
import { PrismaService } from "../../shared/prisma/prisma.service";
import { GUEST_ACTOR, TenantContextService } from "../../shared/tenancy/tenant-context.service";
import { OrderingService } from "../ordering/ordering.service";

/** Trimmed shape of the order.* domain-event payload this service needs. */
export interface LoyaltyOrderLike {
  id: string;
  branchId: string;
  status: string;
  subtotal: unknown;
  total: unknown;
  vatRate: unknown;
  customerName: string | null;
  customerPhone: string | null;
  items: Array<{ productId: string; quantity: number }>;
}

type EffectiveConfig = { isEnabled: boolean; config: Record<string, unknown> } | null;
type ConfigRow = { type: string; branchId: string | null; isEnabled: boolean; config: unknown };

/**
 * Customer identity + balances for the 4 loyalty program types, and the ONLY
 * place that writes to a real order for a loyalty reason: every earn/redeem
 * either goes through OrderingService.applyDiscount (a real discount, VAT
 * recomputed, audited, realtime-broadcast) or OrderingService.addComplimentaryItem
 * (a real $0 line, real recipe cost kept) — this service never prices
 * anything itself.
 */
@Injectable()
export class LoyaltyCustomerService {
  private readonly logger = new Logger(LoyaltyCustomerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
    private readonly ordering: OrderingService,
  ) {}

  // --------------------------------------------------------------------- //
  // Shared config resolution: tenant-wide row, replaced by a branch-specific
  // override when one exists — same nullable-branchId precedence as
  // IntegrationConnection elsewhere in this codebase.
  // --------------------------------------------------------------------- //

  private mergeConfigs(rows: ConfigRow[], branchId: string): Record<LoyaltyProgramType, EffectiveConfig> {
    const result: Record<string, EffectiveConfig> = {
      stamp_card: null,
      spend_threshold: null,
      points_per_riyal: null,
      tier: null,
    };
    for (const row of rows.filter((r) => r.branchId === null)) {
      result[row.type] = { isEnabled: row.isEnabled, config: row.config as Record<string, unknown> };
    }
    for (const row of rows.filter((r) => r.branchId === branchId)) {
      result[row.type] = { isEnabled: row.isEnabled, config: row.config as Record<string, unknown> };
    }
    return result as Record<LoyaltyProgramType, EffectiveConfig>;
  }

  // --------------------------------------------------------------------- //
  // Balance (cashier/dashboard read)
  // --------------------------------------------------------------------- //

  async getBalance(phone: string) {
    const tenantId = this.tenantContext.tenantIdOrThrow;
    const [customer, configRows] = await Promise.all([
      this.prisma.scoped.loyaltyCustomer.findUnique({ where: { tenantId_phone: { tenantId, phone } } }),
      this.prisma.scoped.loyaltyProgramConfig.findMany({ where: { deletedAt: null } }),
    ]);
    const tierCfg = configRows.find((r) => r.type === "tier" && r.branchId === null);
    const tierDef = tierCfg
      ? ((tierCfg.config as unknown as TierConfig).tiers ?? []).find((t) => t.key === customer?.tierKey)
      : undefined;

    return {
      phone,
      exists: Boolean(customer),
      stampCount: customer?.stampCount ?? 0,
      spendAccumulated: customer?.spendAccumulated?.toString() ?? "0.00",
      pointsBalance: customer?.pointsBalance ?? 0,
      lifetimeSpend: customer?.lifetimeSpend?.toString() ?? "0.00",
      tierKey: customer?.tierKey ?? null,
      tierName: tierDef?.nameAr ?? null,
    };
  }

  /**
   * A short Arabic line summarizing progress in every program active at
   * this branch — plugged into the invoice_sent WhatsApp template's
   * loyaltyStatus variable. Empty string when there's nothing to say (no
   * programs enabled, or no history yet for this phone) — WhatsApp still
   * needs the parameter slot filled, just with nothing shown.
   */
  async getWhatsappStatusLine(tenantId: string, branchId: string, phone: string): Promise<string> {
    try {
      const [rows, customer] = await Promise.all([
        this.prisma.forTenant(tenantId).loyaltyProgramConfig.findMany({
          where: { OR: [{ branchId }, { branchId: null }], deletedAt: null },
        }),
        this.prisma.forTenant(tenantId).loyaltyCustomer.findUnique({
          where: { tenantId_phone: { tenantId, phone } },
        }),
      ]);
      if (!customer) return "";
      const configs = this.mergeConfigs(rows, branchId);
      const lines: string[] = [];

      if (configs.stamp_card?.isEnabled) {
        const cfg = configs.stamp_card.config as unknown as StampCardConfig;
        const remaining = cfg.stampsRequired - customer.stampCount;
        lines.push(
          remaining <= 0
            ? "لديك دمغات كافية للحصول على صنف مجاني في طلبك القادم 🎉"
            : `تبقى لك ${remaining} دمغة/دمغات للحصول على صنف مجاني`,
        );
      }
      if (configs.spend_threshold?.isEnabled) {
        const cfg = configs.spend_threshold.config as unknown as SpendThresholdConfig;
        const remaining = Number(cfg.thresholdAmount) - Number(customer.spendAccumulated);
        lines.push(
          remaining <= 0
            ? `لديك خصم ${cfg.discountPercent}% جاهز للاستخدام في طلبك القادم`
            : `تبقى لك ${remaining.toFixed(2)} ريال للحصول على خصم ${cfg.discountPercent}%`,
        );
      }
      if (configs.points_per_riyal?.isEnabled) {
        lines.push(`رصيدك الحالي ${customer.pointsBalance} نقطة`);
      }
      if (configs.tier?.isEnabled && customer.tierKey) {
        const cfg = configs.tier.config as unknown as TierConfig;
        const tierDef = cfg.tiers.find((t) => t.key === customer.tierKey);
        if (tierDef) lines.push(`مستواك الحالي: ${tierDef.nameAr}`);
      }

      return lines.join(" | ");
    } catch (error) {
      this.logger.error(`Loyalty WhatsApp status line failed for ${phone}: ${(error as Error).message}`);
      return "";
    }
  }

  // --------------------------------------------------------------------- //
  // Earning — order.status_changed -> completed
  // --------------------------------------------------------------------- //

  /** Best-effort, non-blocking — same safety rationale as InventoryService.deductForCompletedOrder. */
  async earnForCompletedOrder(tenantId: string, order: LoyaltyOrderLike): Promise<void> {
    if (!order.customerPhone) return;
    await this.tenantContext.run(
      { userId: GUEST_ACTOR, tenantId, branchId: order.branchId, permissions: new Set() },
      () => this.earnForCompletedOrderInContext(tenantId, order),
    );
  }

  private async earnForCompletedOrderInContext(tenantId: string, order: LoyaltyOrderLike): Promise<void> {
    try {
      await this.prisma.scopedTransaction(async (tx) => {
        const rows = await tx.loyaltyProgramConfig.findMany({
          where: { tenantId, OR: [{ branchId: order.branchId }, { branchId: null }], deletedAt: null },
        });
        if (rows.length === 0) return;
        const configs = this.mergeConfigs(rows, order.branchId);

        const existing = await tx.loyaltyCustomer.findUnique({
          where: { tenantId_phone: { tenantId, phone: order.customerPhone! } },
        });
        const customer =
          existing ??
          (await tx.loyaltyCustomer.create({
            data: { tenantId, phone: order.customerPhone!, name: order.customerName },
          }));

        const totalHalalas = sarToHalalas(order.total?.toString() ?? "0");
        const amountSar = halalasToSar(totalHalalas);

        // --- stamp_card: one stamp per matching unit sold ---
        if (configs.stamp_card?.isEnabled) {
          const cfg = configs.stamp_card.config as unknown as StampCardConfig;
          let earned = 0;
          if (cfg.earnProductId) {
            earned = order.items
              .filter((i) => i.productId === cfg.earnProductId)
              .reduce((sum, i) => sum + i.quantity, 0);
          } else if (cfg.earnCategoryId) {
            const productIds = [...new Set(order.items.map((i) => i.productId))];
            const matchingProducts = await tx.product.findMany({
              where: { id: { in: productIds }, categoryId: cfg.earnCategoryId },
              select: { id: true },
            });
            const matchingIds = new Set(matchingProducts.map((p) => p.id));
            earned = order.items
              .filter((i) => matchingIds.has(i.productId))
              .reduce((sum, i) => sum + i.quantity, 0);
          }
          if (earned > 0) {
            await tx.loyaltyCustomer.update({
              where: { id: customer.id },
              data: { stampCount: { increment: earned } },
            });
            await tx.loyaltyLedgerEntry.create({
              data: {
                tenantId,
                branchId: order.branchId,
                customerId: customer.id,
                orderId: order.id,
                type: "stamp_earned",
                amount: earned,
              },
            });
          }
        }

        // --- spend_threshold: accumulate toward the reward, honoring the reset period ---
        if (configs.spend_threshold?.isEnabled) {
          const cfg = configs.spend_threshold.config as unknown as SpendThresholdConfig;
          const resetNow = this.isNewPeriod(customer.spendPeriodStart, cfg.resetPeriod);
          await tx.loyaltyCustomer.update({
            where: { id: customer.id },
            data: {
              spendAccumulated: resetNow ? amountSar : { increment: amountSar },
              ...(resetNow || !customer.spendPeriodStart ? { spendPeriodStart: new Date() } : {}),
            },
          });
          await tx.loyaltyLedgerEntry.create({
            data: {
              tenantId,
              branchId: order.branchId,
              customerId: customer.id,
              orderId: order.id,
              type: "spend_accrued",
              amount: amountSar,
              meta: { counter: "spendAccumulated" },
            },
          });
        }

        // --- points_per_riyal ---
        if (configs.points_per_riyal?.isEnabled) {
          const cfg = configs.points_per_riyal.config as unknown as PointsPerRiyalConfig;
          const earned = Math.floor(Number(amountSar) * cfg.pointsPerRiyal);
          if (earned > 0) {
            await tx.loyaltyCustomer.update({
              where: { id: customer.id },
              data: { pointsBalance: { increment: earned } },
            });
            await tx.loyaltyLedgerEntry.create({
              data: {
                tenantId,
                branchId: order.branchId,
                customerId: customer.id,
                orderId: order.id,
                type: "points_earned",
                amount: earned,
              },
            });
          }
        }

        // --- tier: lifetime spend never resets; recompute the tier every time ---
        if (configs.tier?.isEnabled) {
          const cfg = configs.tier.config as unknown as TierConfig;
          const updated = await tx.loyaltyCustomer.update({
            where: { id: customer.id },
            data: { lifetimeSpend: { increment: amountSar } },
          });
          await tx.loyaltyLedgerEntry.create({
            data: {
              tenantId,
              branchId: order.branchId,
              customerId: customer.id,
              orderId: order.id,
              type: "spend_accrued",
              amount: amountSar,
              meta: { counter: "lifetimeSpend" },
            },
          });
          const newTier = this.computeTier(cfg, updated.lifetimeSpend.toString());
          if ((newTier?.key ?? null) !== updated.tierKey) {
            await tx.loyaltyCustomer.update({
              where: { id: customer.id },
              data: { tierKey: newTier?.key ?? null },
            });
            await tx.loyaltyLedgerEntry.create({
              data: {
                tenantId,
                branchId: order.branchId,
                customerId: customer.id,
                orderId: order.id,
                type: "tier_changed",
                amount: 0,
                meta: { tierFrom: updated.tierKey, tierTo: newTier?.key ?? null },
              },
            });
          }
        }
      }, tenantId);
    } catch (error) {
      this.logger.error(`Loyalty earning failed for order ${order.id}: ${(error as Error).message}`);
    }
  }

  private isNewPeriod(periodStart: Date | null, resetPeriod: string): boolean {
    if (resetPeriod === "none" || !periodStart) return false;
    const now = new Date();
    if (resetPeriod === "monthly") {
      return now.getUTCFullYear() !== periodStart.getUTCFullYear() || now.getUTCMonth() !== periodStart.getUTCMonth();
    }
    if (resetPeriod === "yearly") {
      return now.getUTCFullYear() !== periodStart.getUTCFullYear();
    }
    return false;
  }

  private computeTier(cfg: TierConfig, lifetimeSpend: string) {
    const spend = Number(lifetimeSpend);
    const sorted = [...cfg.tiers].sort((a, b) => Number(a.minSpend) - Number(b.minSpend));
    let current: TierConfig["tiers"][number] | undefined;
    for (const tier of sorted) {
      if (spend >= Number(tier.minSpend)) current = tier;
    }
    return current ?? null;
  }

  // --------------------------------------------------------------------- //
  // Reversal — order cancelled, or fully refunded
  // --------------------------------------------------------------------- //

  /** Best-effort, non-blocking. Undoes every ledger entry tied to this order — earn AND any redemption made on it. */
  async reverseForOrder(tenantId: string, orderId: string): Promise<void> {
    try {
      await this.prisma.scopedTransaction(async (tx) => {
        const entries = await tx.loyaltyLedgerEntry.findMany({ where: { tenantId, orderId } });
        for (const entry of entries) {
          const amount = Number(entry.amount);
          const meta = (entry.meta as { counter?: string } | null) ?? {};
          switch (entry.type) {
            case "stamp_earned":
            case "stamp_redeemed":
              await tx.loyaltyCustomer.update({
                where: { id: entry.customerId },
                data: { stampCount: { increment: -amount } },
              });
              await this.writeReversal(tx, tenantId, entry, "stamp_reversed", -amount);
              break;
            case "points_earned":
            case "points_redeemed":
              await tx.loyaltyCustomer.update({
                where: { id: entry.customerId },
                data: { pointsBalance: { increment: -amount } },
              });
              await this.writeReversal(tx, tenantId, entry, "points_reversed", -amount);
              break;
            case "spend_accrued":
            case "spend_redeemed":
              if (meta.counter === "lifetimeSpend") {
                await tx.loyaltyCustomer.update({
                  where: { id: entry.customerId },
                  data: { lifetimeSpend: { increment: (-amount).toString() } },
                });
              } else {
                await tx.loyaltyCustomer.update({
                  where: { id: entry.customerId },
                  data: { spendAccumulated: { increment: (-amount).toString() } },
                });
              }
              await this.writeReversal(tx, tenantId, entry, "spend_reversed", -amount);
              break;
            default:
              break; // tier_changed and *_reversed entries are informational — nothing to undo
          }
        }
      }, tenantId);
    } catch (error) {
      this.logger.error(`Loyalty reversal failed for order ${orderId}: ${(error as Error).message}`);
    }
  }

  private async writeReversal(
    tx: Prisma.TransactionClient,
    tenantId: string,
    original: { branchId: string; customerId: string; orderId: string | null; meta: unknown },
    type: "stamp_reversed" | "points_reversed" | "spend_reversed",
    amount: number,
  ): Promise<void> {
    await tx.loyaltyLedgerEntry.create({
      data: {
        tenantId,
        branchId: original.branchId,
        customerId: original.customerId,
        orderId: original.orderId,
        type,
        amount,
        meta: { reversed: true, ...(original.meta as object) },
      },
    });
  }

  // --------------------------------------------------------------------- //
  // Redemption — automatic (order.created) and manual (cashier, pre-payment)
  // --------------------------------------------------------------------- //

  /**
   * Runs right after a new order is created for a phone-identified customer:
   * a standing tier discount (if any) is always (re-)applied fresh, combined
   * with AT MOST ONE one-time reward (priority: spend-threshold, else
   * points) into a single real discount — Order has one discount slot, so
   * this system never stacks two separate discount calls. A stamp-card
   * reward is a separate $0 line and is tried independently of the above.
   */
  async autoApplyOnOrderCreated(order: LoyaltyOrderLike): Promise<void> {
    if (!order.customerPhone || ["completed", "cancelled"].includes(order.status)) return;
    const tenantId = this.tenantContext.tenantIdOrThrow;
    try {
      const rows = await this.prisma.scoped.loyaltyProgramConfig.findMany({
        where: { OR: [{ branchId: order.branchId }, { branchId: null }], deletedAt: null },
      });
      if (rows.length === 0) return;
      const configs = this.mergeConfigs(rows, order.branchId);

      const customer = await this.prisma.scoped.loyaltyCustomer.findUnique({
        where: { tenantId_phone: { tenantId, phone: order.customerPhone } },
      });
      if (!customer) return;

      const subtotalHalalas = sarToHalalas(String(order.subtotal));
      let discountHalalas = 0;
      const reasonParts: string[] = [];
      let ledgerWrite: (() => Promise<void>) | null = null;

      if (configs.tier?.isEnabled && customer.tierKey) {
        const cfg = configs.tier.config as unknown as TierConfig;
        const tierDef = cfg.tiers.find((t) => t.key === customer.tierKey);
        if (tierDef && Number(tierDef.discountPercent) > 0) {
          discountHalalas += Math.floor((subtotalHalalas * Number(tierDef.discountPercent)) / 100 + 0.5);
          reasonParts.push(`${tierDef.nameAr} (${tierDef.discountPercent}%)`);
        }
      }

      let oneTimeRewardApplied = false;
      if (configs.spend_threshold?.isEnabled) {
        const cfg = configs.spend_threshold.config as unknown as SpendThresholdConfig;
        if (Number(customer.spendAccumulated) >= Number(cfg.thresholdAmount)) {
          oneTimeRewardApplied = true;
          discountHalalas += Math.floor((subtotalHalalas * Number(cfg.discountPercent)) / 100 + 0.5);
          reasonParts.push(`حد الإنفاق (${cfg.discountPercent}%)`);
          ledgerWrite = async () => {
            // The ledger amount is the ACTUAL reduction applied (not just the
            // threshold) — carryOver:false zeroes the whole balance, which
            // can exceed the threshold itself; recording anything less would
            // under-restore the customer's balance if this order is later
            // cancelled/refunded (see reverseForOrder's generic negate-and-
            // reapply logic, which trusts this amount to be exactly right).
            const before = Number(customer.spendAccumulated);
            const reduction = cfg.carryOver ? Number(cfg.thresholdAmount) : before;
            const newAccumulated = Math.max(0, before - reduction).toFixed(2);
            await this.prisma.scoped.loyaltyCustomer.update({
              where: { id: customer.id },
              data: { spendAccumulated: newAccumulated },
            });
            await this.prisma.scoped.loyaltyLedgerEntry.create({
              data: {
                tenantId,
                branchId: order.branchId,
                customerId: customer.id,
                orderId: order.id,
                type: "spend_redeemed",
                amount: -reduction,
                meta: { counter: "spendAccumulated" },
              },
            });
          };
        }
      }
      if (!oneTimeRewardApplied && configs.points_per_riyal?.isEnabled) {
        const cfg = configs.points_per_riyal.config as unknown as PointsPerRiyalConfig;
        if (customer.pointsBalance >= cfg.redemptionPointsUnit) {
          const units = Math.floor(customer.pointsBalance / cfg.redemptionPointsUnit);
          const pointsToSpend = units * cfg.redemptionPointsUnit;
          const discountSar = (units * Number(cfg.redemptionSarValue)).toFixed(2);
          discountHalalas += sarToHalalas(discountSar);
          reasonParts.push(`نقاط الولاء (${pointsToSpend} نقطة)`);
          ledgerWrite = async () => {
            await this.prisma.scoped.loyaltyCustomer.update({
              where: { id: customer.id },
              data: { pointsBalance: { decrement: pointsToSpend } },
            });
            await this.prisma.scoped.loyaltyLedgerEntry.create({
              data: {
                tenantId,
                branchId: order.branchId,
                customerId: customer.id,
                orderId: order.id,
                type: "points_redeemed",
                amount: -pointsToSpend,
                meta: { discountSar },
              },
            });
          };
        }
      }

      if (discountHalalas > 0) {
        const cappedHalalas = Math.min(discountHalalas, subtotalHalalas);
        await this.ordering.applyDiscount(
          order.id,
          { type: "fixed", value: halalasToSar(cappedHalalas), reason: `مكافأة الولاء: ${reasonParts.join(" + ")}` },
          { bypassCap: true },
        );
        if (ledgerWrite) await ledgerWrite();
      }

      if (configs.stamp_card?.isEnabled) {
        const cfg = configs.stamp_card.config as unknown as StampCardConfig;
        if (customer.stampCount >= cfg.stampsRequired) {
          await this.ordering.addComplimentaryItem(order.id, cfg.rewardProductId, "مكافأة بطاقة الدمغات");
          await this.prisma.scoped.loyaltyCustomer.update({
            where: { id: customer.id },
            data: { stampCount: { decrement: cfg.stampsRequired } },
          });
          await this.prisma.scoped.loyaltyLedgerEntry.create({
            data: {
              tenantId,
              branchId: order.branchId,
              customerId: customer.id,
              orderId: order.id,
              type: "stamp_redeemed",
              amount: -cfg.stampsRequired,
              meta: { rewardProductId: cfg.rewardProductId },
            },
          });
        }
      }
    } catch (error) {
      this.logger.error(`Loyalty auto-redeem failed for order ${order.id}: ${(error as Error).message}`);
    }
  }

  /**
   * Manual redemption — the cashier applies an available reward to an open,
   * unpaid order before payment (e.g. the automatic pass didn't fire because
   * the phone was entered after order creation). Reuses the exact same
   * OrderingService primitives as the automatic path.
   */
  async redeemManually(orderId: string, type: LoyaltyProgramType, performedBy: string | null) {
    const tenantId = this.tenantContext.tenantIdOrThrow;
    const order = await this.prisma.scoped.order.findFirst({ where: { id: orderId, deletedAt: null } });
    if (!order) {
      throw new NotFoundException("Order not found");
    }
    if (!order.customerPhone) {
      throw new ConflictException("Order has no customer phone number to look up a loyalty balance");
    }
    if (["completed", "cancelled"].includes(order.status)) {
      throw new ConflictException("Order is closed");
    }

    const configRow = await this.prisma.scoped.loyaltyProgramConfig.findFirst({
      where: { OR: [{ branchId: order.branchId }, { branchId: null }], type, deletedAt: null },
      orderBy: { branchId: { sort: "desc", nulls: "last" } },
    });
    if (!configRow?.isEnabled) {
      throw new ConflictException("This loyalty program is not enabled at this branch");
    }
    const customer = await this.prisma.scoped.loyaltyCustomer.findUnique({
      where: { tenantId_phone: { tenantId, phone: order.customerPhone } },
    });
    if (!customer) {
      throw new NotFoundException("No loyalty history for this customer yet");
    }

    if (type === "stamp_card") {
      const cfg = configRow.config as unknown as StampCardConfig;
      if (customer.stampCount < cfg.stampsRequired) {
        throw new ConflictException(
          `Customer has ${customer.stampCount}/${cfg.stampsRequired} stamps — not enough yet`,
        );
      }
      await this.ordering.addComplimentaryItem(orderId, cfg.rewardProductId, "مكافأة بطاقة الدمغات (تطبيق يدوي)");
      await this.prisma.scoped.loyaltyCustomer.update({
        where: { id: customer.id },
        data: { stampCount: { decrement: cfg.stampsRequired } },
      });
      await this.prisma.scoped.loyaltyLedgerEntry.create({
        data: {
          tenantId,
          branchId: order.branchId,
          customerId: customer.id,
          orderId,
          type: "stamp_redeemed",
          amount: -cfg.stampsRequired,
          meta: { rewardProductId: cfg.rewardProductId, manual: true },
          performedBy,
        },
      });
      return { applied: true };
    }

    if (type === "spend_threshold") {
      const cfg = configRow.config as unknown as SpendThresholdConfig;
      if (Number(customer.spendAccumulated) < Number(cfg.thresholdAmount)) {
        throw new ConflictException(
          `Customer has ${customer.spendAccumulated} of ${cfg.thresholdAmount} SAR — threshold not met yet`,
        );
      }
      await this.ordering.applyDiscount(
        orderId,
        { type: "percentage", value: cfg.discountPercent, reason: "مكافأة برنامج الولاء — حد الإنفاق (تطبيق يدوي)" },
        { bypassCap: true },
      );
      // See autoApplyOnOrderCreated's identical comment: the ledger amount
      // must be the ACTUAL reduction (not just the threshold), or a later
      // cancellation/refund would under-restore the customer's balance.
      const spendBefore = Number(customer.spendAccumulated);
      const spendReduction = cfg.carryOver ? Number(cfg.thresholdAmount) : spendBefore;
      const newAccumulated = Math.max(0, spendBefore - spendReduction).toFixed(2);
      await this.prisma.scoped.loyaltyCustomer.update({
        where: { id: customer.id },
        data: { spendAccumulated: newAccumulated },
      });
      await this.prisma.scoped.loyaltyLedgerEntry.create({
        data: {
          tenantId,
          branchId: order.branchId,
          customerId: customer.id,
          orderId,
          type: "spend_redeemed",
          amount: -spendReduction,
          meta: { counter: "spendAccumulated", manual: true },
          performedBy,
        },
      });
      return { applied: true };
    }

    if (type === "points_per_riyal") {
      const cfg = configRow.config as unknown as PointsPerRiyalConfig;
      if (customer.pointsBalance < cfg.redemptionPointsUnit) {
        throw new ConflictException(
          `Customer has ${customer.pointsBalance} points — needs at least ${cfg.redemptionPointsUnit}`,
        );
      }
      const units = Math.floor(customer.pointsBalance / cfg.redemptionPointsUnit);
      const pointsToSpend = units * cfg.redemptionPointsUnit;
      const discountSar = (units * Number(cfg.redemptionSarValue)).toFixed(2);
      await this.ordering.applyDiscount(
        orderId,
        { type: "fixed", value: discountSar, reason: "مكافأة برنامج الولاء — نقاط (تطبيق يدوي)" },
        { bypassCap: true },
      );
      await this.prisma.scoped.loyaltyCustomer.update({
        where: { id: customer.id },
        data: { pointsBalance: { decrement: pointsToSpend } },
      });
      await this.prisma.scoped.loyaltyLedgerEntry.create({
        data: {
          tenantId,
          branchId: order.branchId,
          customerId: customer.id,
          orderId,
          type: "points_redeemed",
          amount: -pointsToSpend,
          meta: { discountSar, manual: true },
          performedBy,
        },
      });
      return { applied: true };
    }

    throw new ConflictException("Tier is a standing discount — it is applied automatically, not redeemed manually");
  }
}
