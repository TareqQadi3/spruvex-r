import { Injectable } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { DOMAIN_EVENTS } from "@spruvex-r/types";

import { PrismaService } from "../../../shared/prisma/prisma.service";
import { WhatsappService } from "./whatsapp.service";

interface ReorderAlertPayload {
  tenantId: string;
  branchId: string;
  ingredientId: string;
  currentQuantity: string;
  reorderLevel: string;
}

/**
 * Turns the passive reorder-alerts screen (InventoryService's
 * INGREDIENT_REORDER_ALERT event, emitted once per crossing — see
 * reevaluateReorderAlerts's doc comment for the "only notify once while
 * still low" rule) into a proactive WhatsApp notification to the tenant's
 * OWN registered contact number (Tenant.contactPhone — "the restaurant's
 * main contact number", the closest existing field to "the registered
 * merchant/manager phone"; this is the first WhatsApp template in this
 * codebase sent to the RESTAURANT itself rather than a customer, but
 * WhatsappService.sendTemplate is a generic phone+template sender with
 * nothing customer-specific about it).
 *
 * Two independent gates, both required, same as every other tenant-level
 * automated WhatsApp send:
 * 1. Tenant.settings.reorderAlertsWhatsappEnabled — off by default (see
 *    ReorderAlertsService.getWhatsappSettings), so no existing tenant is
 *    surprised by a message they never opted into.
 * 2. The "low_stock_alert" template itself must be marked approved with a
 *    real Meta template name (WhatsappTemplateOverride) — the exact same
 *    gate every other template already goes through inside
 *    WhatsappService.sendTemplate; this listener adds no template-specific
 *    logic of its own.
 */
@Injectable()
export class ReorderAlertListener {
  constructor(
    private readonly whatsapp: WhatsappService,
    private readonly prisma: PrismaService,
  ) {}

  @OnEvent(DOMAIN_EVENTS.INGREDIENT_REORDER_ALERT)
  async onReorderAlert(payload: ReorderAlertPayload): Promise<void> {
    const tenant = await this.prisma.scoped.tenant.findUnique({
      where: { id: payload.tenantId },
      select: { contactPhone: true, settings: true },
    });
    const settings = (tenant?.settings ?? {}) as { reorderAlertsWhatsappEnabled?: boolean };
    if (!settings.reorderAlertsWhatsappEnabled || !tenant?.contactPhone) {
      return;
    }

    const [ingredient, branch] = await Promise.all([
      this.prisma.scoped.ingredient.findUnique({
        where: { id: payload.ingredientId },
        select: { name: true },
      }),
      this.prisma.scoped.branch.findUnique({
        where: { id: payload.branchId },
        select: { name: true },
      }),
    ]);
    if (!ingredient || !branch) return;

    await this.whatsapp.sendTemplate("low_stock_alert", tenant.contactPhone, {
      ingredientName: ingredient.name,
      currentQuantity: payload.currentQuantity,
      reorderLevel: payload.reorderLevel,
      branchName: branch.name,
    });
  }
}
