export interface MenuModifier {
  id: string;
  name: string;
  nameEn: string | null;
  priceAdjustment: string;
}

export interface MenuModifierGroup {
  id: string;
  name: string;
  nameEn: string | null;
  isRequired: boolean;
  minSelect: number;
  maxSelect: number | null;
  modifiers: MenuModifier[];
}

export interface MenuProduct {
  id: string;
  categoryId: string;
  name: string;
  nameEn: string | null;
  description: string | null;
  descriptionEn: string | null;
  imageUrl: string | null;
  price: string;
  badges: string[];
  prepTimeMinutes: number | null;
  modifierGroups: MenuModifierGroup[];
}

export interface MenuCategory {
  id: string;
  name: string;
  nameEn: string | null;
  description: string | null;
  imageUrl: string | null;
}

export interface Menu {
  categories: MenuCategory[];
  products: MenuProduct[];
}

export interface ChannelStatus {
  channel: "dine_in" | "takeaway" | "delivery";
  open: boolean;
  reason: string;
  label?: string;
}

export interface TableInfo {
  restaurant: {
    name: string;
    nameEn: string | null;
    slug: string;
    logoUrl: string | null;
    currency: string;
    defaultLocale: string;
    menuTemplate: string;
    menuCustomCss: string | null;
  };
  branch: { name: string; nameEn: string | null };
  table: { number: string; status: string };
  channelStatus: ChannelStatus;
}

export interface RestaurantInfo {
  restaurant: {
    name: string;
    nameEn: string | null;
    slug: string;
    logoUrl: string | null;
    currency: string;
    defaultLocale: string;
    menuTemplate: string;
    menuCustomCss: string | null;
  };
  branches: Array<{
    id: string;
    name: string;
    nameEn: string | null;
    slug: string;
    address: string | null;
    phone: string | null;
  }>;
}

export interface BranchMenu extends Menu {
  branch: { name: string; nameEn: string | null; slug: string };
  channelStatuses: { takeaway: ChannelStatus; delivery: ChannelStatus };
  delivery: { feeAmount: string; minOrderAmount: string; estimatedMinutes: number; paymentMethods: ("cash" | "online")[] };
  pickup: { estimatedMinutes: number; paymentMethods: ("cash" | "online")[] };
}

export interface CartLineInput {
  productId: string;
  quantity: number;
  modifierIds?: string[];
  notes?: string;
}

export interface GuestOrderResult {
  orderId: string;
  /** Present for shared table-session orders — the same value for every
   * participant who joined the same table's QR. */
  sessionId?: string;
  orderNumber: number;
  status: string;
  total: string;
}

export interface TrackedOrder {
  id: string;
  orderNumber: number;
  status: string;
  type: string;
  total: string;
  createdAt: string;
  table: string | null;
  restaurant: {
    name: string;
    nameEn: string | null;
    logoUrl: string | null;
    currency: string;
    defaultLocale: string;
  };
  items: Array<{ quantity: number; name: string; nameEn: string | null; participantPhone?: string | null }>;
}
