import { BadRequestException, Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import type { IntegrationCategory } from "@prisma/client";
import {
  DELIVERY_PROVIDER_KEYS,
  NFC_PROVIDER_KEYS,
  PAYMENT_GATEWAY_PROVIDER_KEYS,
} from "@spruvex-r/types";

import { RequirePermission } from "../../shared/rbac/require-permission.decorator";
import { ConnectionsService } from "./connections.service";
import { UpsertConnectionDto } from "./dto/connection.dto";

const CATEGORY_PROVIDERS: Record<IntegrationCategory, readonly string[]> = {
  delivery_platform: DELIVERY_PROVIDER_KEYS,
  payment_gateway: PAYMENT_GATEWAY_PROVIDER_KEYS,
  nfc_terminal: NFC_PROVIDER_KEYS,
  whatsapp: ["whatsapp_cloud"],
};

function assertCategory(category: string): IntegrationCategory {
  if (!Object.prototype.hasOwnProperty.call(CATEGORY_PROVIDERS, category)) {
    throw new BadRequestException(`Unknown integration category "${category}"`);
  }
  return category as IntegrationCategory;
}

/**
 * Generic connection management for every integration category (delivery
 * platform, payment gateway, NFC terminal, WhatsApp) — one CRUD surface the
 * dashboard's "Integrations" page drives, backing each category's card.
 * Provider-specific behavior (webhooks, checkout, sending) lives in each
 * category's own controller; this one never touches order/payment data.
 */
@RequirePermission("tenant.settings.manage")
@Controller("integrations/connections")
export class ConnectionsController {
  constructor(private readonly connections: ConnectionsService) {}

  @Get()
  list() {
    return this.connections.list();
  }

  @Get(":category")
  listByCategory(@Param("category") categoryParam: string) {
    const category = assertCategory(categoryParam);
    return this.connections.list(category);
  }

  @Post(":category")
  upsert(@Param("category") categoryParam: string, @Body() dto: UpsertConnectionDto) {
    const category = assertCategory(categoryParam);
    return this.connections.upsert(category, dto, CATEGORY_PROVIDERS[category]);
  }

  @Delete(":id")
  disconnect(@Param("id", ParseUUIDPipe) id: string) {
    return this.connections.disconnect(id).then(() => ({ disconnected: true }));
  }
}
