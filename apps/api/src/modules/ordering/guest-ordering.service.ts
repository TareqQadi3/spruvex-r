import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";

import { PlatformPrismaService } from "../../shared/prisma/platform-prisma.service";
import { PrismaService } from "../../shared/prisma/prisma.service";
import {
  GUEST_ACTOR,
  TenantContextService,
} from "../../shared/tenancy/tenant-context.service";
import { GuestCreateOrderDto } from "./dto/order.dto";
import { OrderingService } from "./ordering.service";

/**
 * Guest (QR) ordering. The QR token is the only credential: it is resolved
 * to tenant/branch/table on the platform connection (tokens are globally
 * unique, and no tenant context exists yet), after which every data access
 * runs inside that tenant's RLS scope with the guest sentinel actor.
 */
@Injectable()
export class GuestOrderingService {
  constructor(
    private readonly platformDb: PlatformPrismaService,
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly ordering: OrderingService,
  ) {}

  private async resolveToken(qrToken: string) {
    const table = await this.platformDb.table.findFirst({
      where: { qrToken, deletedAt: null },
      include: {
        branch: {
          select: {
            id: true,
            name: true,
            nameEn: true,
            isActive: true,
            deletedAt: true,
            orderingSettings: true,
          },
        },
        tenant: {
          select: {
            id: true,
            name: true,
            nameEn: true,
            slug: true,
            logoUrl: true,
            currency: true,
            defaultLocale: true,
            status: true,
            menuTemplate: true,
            menuCustomCss: true,
          },
        },
      },
    });
    if (
      !table ||
      table.tenant.status !== "active" ||
      !table.branch.isActive ||
      table.branch.deletedAt
    ) {
      throw new NotFoundException("QR code is not valid");
    }
    const settings = (table.branch.orderingSettings ?? {}) as { qrOrderingEnabled?: boolean };
    if (settings.qrOrderingEnabled === false) {
      throw new ConflictException("QR ordering is currently disabled for this branch");
    }
    return table;
  }

  async tableInfo(qrToken: string) {
    const table = await this.resolveToken(qrToken);
    return {
      restaurant: {
        name: table.tenant.name,
        nameEn: table.tenant.nameEn,
        slug: table.tenant.slug,
        logoUrl: table.tenant.logoUrl,
        currency: table.tenant.currency,
        defaultLocale: table.tenant.defaultLocale,
        menuTemplate: table.tenant.menuTemplate,
        menuCustomCss: table.tenant.menuCustomCss,
      },
      branch: { name: table.branch.name, nameEn: table.branch.nameEn },
      table: { number: table.number, status: table.status },
    };
  }

  /** Active menu for the table's branch (branch availability + price overrides applied). */
  async menu(qrToken: string) {
    const table = await this.resolveToken(qrToken);
    return this.buildMenu(table.tenantId, table.branchId);
  }

  // --- External ordering link (/restaurant/{slug}) --------------------- //

  private async resolveRestaurant(slug: string) {
    const tenant = await this.platformDb.tenant.findFirst({
      where: { slug, status: "active", deletedAt: null },
      select: {
        id: true,
        name: true,
        nameEn: true,
        slug: true,
        logoUrl: true,
        currency: true,
        defaultLocale: true,
        menuTemplate: true,
        menuCustomCss: true,
      },
    });
    if (!tenant) {
      throw new NotFoundException("Restaurant not found");
    }
    return tenant;
  }

  private async resolveBranch(slug: string, branchSlug: string) {
    const tenant = await this.resolveRestaurant(slug);
    const branch = await this.prisma.forTenant(tenant.id).branch.findFirst({
      where: { slug: branchSlug, deletedAt: null, isActive: true },
      select: { id: true, name: true, nameEn: true, slug: true, address: true, phone: true },
    });
    if (!branch) {
      throw new NotFoundException("Branch not found");
    }
    return { tenant, branch };
  }

  /** Public restaurant page: info + active branches (pickup entry points). */
  async restaurantInfo(slug: string) {
    const tenant = await this.resolveRestaurant(slug);
    const branches = await this.prisma.forTenant(tenant.id).branch.findMany({
      where: { deletedAt: null, isActive: true },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, nameEn: true, slug: true, address: true, phone: true },
    });
    const { id: _id, ...restaurant } = tenant;
    return { restaurant, branches };
  }

  async branchMenu(slug: string, branchSlug: string) {
    const { tenant, branch } = await this.resolveBranch(slug, branchSlug);
    const menu = await this.buildMenu(tenant.id, branch.id);
    return { branch: { name: branch.name, nameEn: branch.nameEn, slug: branch.slug }, ...menu };
  }

  /** Pickup (takeaway) order through the external link — phone required. */
  async createTakeawayOrder(
    slug: string,
    branchSlug: string,
    dto: GuestCreateOrderDto & { customerPhone: string },
    idempotencyKey: string,
  ) {
    const { tenant, branch } = await this.resolveBranch(slug, branchSlug);

    const order = await this.tenantContext.run(
      { userId: GUEST_ACTOR, tenantId: tenant.id, permissions: new Set() },
      () =>
        this.ordering.create(
          {
            type: "takeaway",
            branchId: branch.id,
            items: dto.items,
            notes: dto.notes,
            customerName: dto.customerName,
            customerPhone: dto.customerPhone,
          },
          { source: "external_link", tenantId: tenant.id },
          idempotencyKey,
        ),
    );
    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      total: order.total.toString(),
    };
  }

  /**
   * Guest order tracking. The order UUID is the capability: it is returned
   * only to whoever placed the order. Response is trimmed to customer-safe
   * fields — no actors, no staff data.
   */
  async track(orderId: string) {
    const order = await this.platformDb.order.findFirst({
      where: { id: orderId, deletedAt: null },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        type: true,
        total: true,
        createdAt: true,
        table: { select: { number: true } },
        tenant: {
          select: { name: true, nameEn: true, logoUrl: true, currency: true, defaultLocale: true },
        },
        items: {
          select: { quantity: true, productSnapshot: true },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (!order) {
      throw new NotFoundException("Order not found");
    }
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      type: order.type,
      total: order.total.toString(),
      createdAt: order.createdAt,
      table: order.table?.number ?? null,
      restaurant: order.tenant,
      items: order.items.map((item) => ({
        quantity: item.quantity,
        name: (item.productSnapshot as { name: string }).name,
        nameEn: (item.productSnapshot as { nameEn: string | null }).nameEn,
      })),
    };
  }

  // ---------------------------------------------------------------------- //

  private async buildMenu(tenantId: string, branchId: string) {
    const scoped = this.prisma.forTenant(tenantId);

    const categories = await scoped.category.findMany({
      where: { deletedAt: null, isActive: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, name: true, nameEn: true, description: true, imageUrl: true },
    });
    const products = await scoped.product.findMany({
      where: { deletedAt: null, isActive: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      include: {
        branchSettings: { where: { branchId } },
        modifierGroups: {
          orderBy: { sortOrder: "asc" },
          include: {
            group: {
              include: {
                modifiers: {
                  where: { deletedAt: null, isActive: true },
                  orderBy: { sortOrder: "asc" },
                },
              },
            },
          },
        },
      },
    });

    return {
      categories,
      products: products
        .filter((product) => product.branchSettings[0]?.isAvailable !== false)
        .map((product) => ({
          id: product.id,
          categoryId: product.categoryId,
          name: product.name,
          nameEn: product.nameEn,
          description: product.description,
          descriptionEn: product.descriptionEn,
          imageUrl: product.imageUrl,
          price: (product.branchSettings[0]?.priceOverride ?? product.basePrice).toString(),
          modifierGroups: product.modifierGroups
            .filter((link) => link.group.deletedAt === null && link.group.isActive)
            .map((link) => ({
              id: link.group.id,
              name: link.group.name,
              nameEn: link.group.nameEn,
              isRequired: link.group.isRequired,
              minSelect: link.group.minSelect,
              maxSelect: link.group.maxSelect,
              modifiers: link.group.modifiers.map((modifier) => ({
                id: modifier.id,
                name: modifier.name,
                nameEn: modifier.nameEn,
                priceAdjustment: modifier.priceAdjustment.toString(),
              })),
            })),
        })),
    };
  }

  /** Creates a dine-in order attached to the table's open session. */
  async createOrder(qrToken: string, dto: GuestCreateOrderDto, idempotencyKey: string) {
    const table = await this.resolveToken(qrToken);

    const order = await this.tenantContext.run(
      { userId: GUEST_ACTOR, tenantId: table.tenantId, permissions: new Set() },
      () =>
        this.ordering.create(
          {
            type: "dine_in",
            tableId: table.id,
            items: dto.items,
            notes: dto.notes,
            customerName: dto.customerName,
          },
          { source: "qr", tenantId: table.tenantId },
          idempotencyKey,
        ),
    );

    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      total: order.total.toString(),
    };
  }
}
