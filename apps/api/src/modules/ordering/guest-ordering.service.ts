import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";

import type { OrderingChannel } from "@spruvex-r/types";

import { BusinessHoursService } from "../../shared/business-hours/business-hours.service";
import { PlatformPrismaService } from "../../shared/prisma/platform-prisma.service";
import { PrismaService } from "../../shared/prisma/prisma.service";
import {
  GUEST_ACTOR,
  TenantContextService,
} from "../../shared/tenancy/tenant-context.service";
import { GuestCreateOrderDto, GuestDeliveryOrderDto, GuestTableOrderDto } from "./dto/order.dto";
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
    private readonly businessHours: BusinessHoursService,
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
    const channelStatus = await this.tenantContext.run(
      { userId: GUEST_ACTOR, tenantId: table.tenantId, permissions: new Set() },
      () => this.businessHours.getChannelStatus(table.branchId, "dine_in"),
    );
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
      channelStatus,
    };
  }

  /**
   * Active menu for the table's branch — branch availability, per-channel
   * (dine_in) visibility/price overrides, and per-branch modifier
   * availability all applied. Never blocked by hours/pause: browsing is
   * always allowed, only order creation checks that (item 1's "show the
   * menu, disable checkout" requirement) — `channelStatus` tells the
   * frontend what banner to show.
   */
  async menu(qrToken: string) {
    const table = await this.resolveToken(qrToken);
    return this.buildMenu(table.tenantId, table.branchId, "dine_in");
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
      select: {
        id: true,
        name: true,
        nameEn: true,
        slug: true,
        address: true,
        phone: true,
        lat: true,
        lng: true,
        deliveryFeeAmount: true,
        deliveryMinOrderAmount: true,
        deliveryRadiusKm: true,
        deliveryEstimatedMinutes: true,
        pickupEstimatedMinutes: true,
        selfServicePaymentMethods: true,
      },
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

  /**
   * `channel` selects which self-service ordering mode the customer is
   * currently viewing (pricing/visibility overrides + hours status apply
   * accordingly); omit while the customer hasn't picked pickup vs delivery
   * yet — the branch-level base price/availability still applies, and both
   * channels' live status + the branch's delivery config are always
   * included so the frontend can render the picker correctly up front.
   */
  async branchMenu(slug: string, branchSlug: string, channel?: "takeaway" | "delivery") {
    const { tenant, branch } = await this.resolveBranch(slug, branchSlug);
    const menu = await this.buildMenu(tenant.id, branch.id, channel);
    const [takeawayStatus, deliveryStatus] = await this.tenantContext.run(
      { userId: GUEST_ACTOR, tenantId: tenant.id, permissions: new Set() },
      () =>
        Promise.all([
          this.businessHours.getChannelStatus(branch.id, "takeaway"),
          this.businessHours.getChannelStatus(branch.id, "delivery"),
        ]),
    );
    return {
      branch: { name: branch.name, nameEn: branch.nameEn, slug: branch.slug },
      ...menu,
      channelStatuses: { takeaway: takeawayStatus, delivery: deliveryStatus },
      delivery: {
        feeAmount: branch.deliveryFeeAmount.toString(),
        minOrderAmount: branch.deliveryMinOrderAmount.toString(),
        estimatedMinutes: branch.deliveryEstimatedMinutes,
        paymentMethods: branch.selfServicePaymentMethods,
      },
      pickup: {
        estimatedMinutes: branch.pickupEstimatedMinutes,
        paymentMethods: branch.selfServicePaymentMethods,
      },
    };
  }

  /** Pickup (takeaway) order through the external link — phone required. */
  async createTakeawayOrder(
    slug: string,
    branchSlug: string,
    dto: GuestCreateOrderDto & { customerPhone: string; paymentMethod?: "cash" | "online" },
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
            intendedPaymentMethod: dto.paymentMethod,
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
      estimatedMinutes: branch.pickupEstimatedMinutes,
    };
  }

  /**
   * First-party delivery order through the external link — address
   * mandatory, "Pin" (lat/lng) optional and only used for the delivery-
   * radius check when the branch has one configured. Fee/minimum-
   * order/radius/payment-method are all enforced server-side inside
   * OrderingService.create (never trust the frontend to have hidden an
   * out-of-range address or a below-minimum cart).
   */
  async createDeliveryOrder(
    slug: string,
    branchSlug: string,
    dto: GuestDeliveryOrderDto,
    idempotencyKey: string,
  ) {
    const { tenant, branch } = await this.resolveBranch(slug, branchSlug);

    const order = await this.tenantContext.run(
      { userId: GUEST_ACTOR, tenantId: tenant.id, permissions: new Set() },
      () =>
        this.ordering.create(
          {
            type: "delivery",
            branchId: branch.id,
            items: dto.items,
            notes: dto.notes,
            customerName: dto.customerName,
            customerPhone: dto.customerPhone,
            deliveryAddress: dto.deliveryAddress,
            deliveryLat: dto.deliveryLat,
            deliveryLng: dto.deliveryLng,
            intendedPaymentMethod: dto.paymentMethod,
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
      deliveryFeeAmount: order.deliveryFeeAmount?.toString() ?? "0",
      estimatedMinutes: branch.deliveryEstimatedMinutes,
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
          select: { quantity: true, productSnapshot: true, participantPhone: true },
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
        participantPhone: item.participantPhone,
      })),
    };
  }

  // ---------------------------------------------------------------------- //

  /**
   * `channel` applies per-channel visibility/price overrides on top of the
   * branch-level base setting (item 3) — omit it for the "haven't picked
   * pickup vs delivery yet" browse view, which just uses branch-level
   * pricing/availability. Modifier options hidden per-branch (item 2) are
   * filtered out the same way products are.
   */
  private async buildMenu(tenantId: string, branchId: string, channel?: OrderingChannel) {
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
        channelOverrides: channel ? { where: { branchId, channel } } : false,
        modifierGroups: {
          orderBy: { sortOrder: "asc" },
          include: {
            group: {
              include: {
                modifiers: {
                  where: { deletedAt: null, isActive: true },
                  orderBy: { sortOrder: "asc" },
                  include: { branchSettings: { where: { branchId } } },
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
        .filter((product) => !channel || product.channelOverrides?.[0]?.isVisible !== false)
        .map((product) => {
          const channelOverride = channel ? product.channelOverrides?.[0] : undefined;
          return {
            id: product.id,
            categoryId: product.categoryId,
            name: product.name,
            nameEn: product.nameEn,
            description: product.description,
            descriptionEn: product.descriptionEn,
            imageUrl: product.imageUrl,
            price: (
              channelOverride?.priceOverride ??
              product.branchSettings[0]?.priceOverride ??
              product.basePrice
            ).toString(),
            badges: product.badges,
            prepTimeMinutes: product.prepTimeMinutes,
            modifierGroups: product.modifierGroups
              .filter((link) => link.group.deletedAt === null && link.group.isActive)
              .map((link) => ({
                id: link.group.id,
                name: link.group.name,
                nameEn: link.group.nameEn,
                isRequired: link.group.isRequired,
                minSelect: link.group.minSelect,
                maxSelect: link.group.maxSelect,
                modifiers: link.group.modifiers
                  .filter((modifier) => modifier.branchSettings[0]?.isAvailable !== false)
                  .map((modifier) => ({
                    id: modifier.id,
                    name: modifier.name,
                    nameEn: modifier.nameEn,
                    priceAdjustment: modifier.priceAdjustment.toString(),
                  })),
              })),
          };
        }),
    };
  }

  /**
   * Joins (or opens) the table's shared session and either creates its
   * first order or appends this round to whichever order the session
   * already has open — see `OrderingService.orderForTable` for the whole
   * "several phones, one real order" mechanism and its concurrency handling.
   */
  async createOrder(qrToken: string, dto: GuestTableOrderDto, idempotencyKey: string) {
    const table = await this.resolveToken(qrToken);

    const { order, sessionId } = await this.tenantContext.run(
      { userId: GUEST_ACTOR, tenantId: table.tenantId, permissions: new Set() },
      () =>
        this.ordering.orderForTable(
          table.id,
          dto.items,
          dto.customerPhone,
          { source: "qr", notes: dto.notes, customerName: dto.customerName },
          idempotencyKey,
        ),
    );

    return {
      orderId: order.id,
      sessionId,
      orderNumber: order.orderNumber,
      status: order.status,
      total: order.total.toString(),
    };
  }
}
