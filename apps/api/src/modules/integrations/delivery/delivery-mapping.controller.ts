import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";

import { RequirePermission } from "../../../shared/rbac/require-permission.decorator";
import { PrismaService } from "../../../shared/prisma/prisma.service";
import { TenantContextService } from "../../../shared/tenancy/tenant-context.service";
import { UpsertDeliveryMappingDto } from "./dto/delivery-mapping.dto";

/**
 * Maps internal catalog products to a delivery platform's own item ids, so
 * an incoming webhook order (which only knows the platform's ids) resolves
 * to a real product. Populated by the owner once per product — there's no
 * live partner API access in this environment to auto-sync against (see
 * hungerstation.provider.ts's doc comment); a real push-sync of price/
 * availability is a natural next step once that access exists.
 */
@RequirePermission("tenant.settings.manage")
@Controller("integrations/delivery/mappings")
export class DeliveryMappingController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  list(@Query("connectionId", ParseUUIDPipe) connectionId: string) {
    return this.prisma.scoped.deliveryProductMapping.findMany({
      where: { connectionId },
      include: { product: { select: { id: true, name: true, nameEn: true, sku: true } } },
      orderBy: { createdAt: "asc" },
    });
  }

  @Post()
  async upsert(@Body() dto: UpsertDeliveryMappingDto) {
    const existing = await this.prisma.scoped.deliveryProductMapping.findFirst({
      where: { connectionId: dto.connectionId, productId: dto.productId },
    });
    if (existing) {
      return this.prisma.scoped.deliveryProductMapping.update({
        where: { id: existing.id },
        data: { externalItemId: dto.externalItemId, externalItemName: dto.externalItemName },
      });
    }
    return this.prisma.scoped.deliveryProductMapping.create({
      data: {
        tenantId: this.tenantContext.tenantIdOrThrow,
        connectionId: dto.connectionId,
        productId: dto.productId,
        externalItemId: dto.externalItemId,
        externalItemName: dto.externalItemName,
      },
    });
  }

  @Delete(":id")
  async remove(@Param("id", ParseUUIDPipe) id: string) {
    await this.prisma.scoped.deliveryProductMapping.delete({ where: { id } });
    return { removed: true };
  }
}
