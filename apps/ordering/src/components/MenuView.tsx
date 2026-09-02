"use client";

import { useMemo, useState } from "react";

import { useLocale } from "./LocaleProvider";
import { CategoryNav } from "./CategoryNav";
import { ProductCard } from "./ProductCard";
import type { ChannelStatus, Menu } from "@/lib/types";

/**
 * Browsing is never blocked by hours/pause — only order creation is (see
 * OrderingService.assertChannelOpen, the real server-side gate). This banner
 * + disabled product cards are a UX courtesy so a customer doesn't build a
 * cart only to have checkout rejected; the actual enforcement happens
 * regardless of whether this renders correctly.
 */
function ClosedBanner({ status }: { status: ChannelStatus }) {
  const { t } = useLocale();
  return (
    <div
      data-menu-part="closed-banner"
      className="mx-4 mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
    >
      <p className="font-semibold">{t("menu.closedNow")}</p>
      {status.label && <p className="mt-0.5 text-xs">{status.label}</p>}
      <p className="mt-0.5 text-xs">{t("menu.closedBrowseHint")}</p>
    </div>
  );
}

export function MenuView({
  menu,
  currency,
  channelStatus,
}: {
  menu: Menu;
  currency: string;
  channelStatus?: ChannelStatus;
}) {
  const { t } = useLocale();
  const categoriesWithProducts = useMemo(
    () => menu.categories.filter((c) => menu.products.some((p) => p.categoryId === c.id)),
    [menu],
  );
  const [activeId, setActiveId] = useState<string | null>(
    categoriesWithProducts[0]?.id ?? null,
  );

  if (menu.products.length === 0) {
    return <p className="p-8 text-center text-muted-foreground">{t("menu.empty")}</p>;
  }

  const visibleProducts = activeId
    ? menu.products.filter((p) => p.categoryId === activeId)
    : menu.products;
  const closed = channelStatus ? !channelStatus.open : false;

  return (
    <>
      {closed && channelStatus && <ClosedBanner status={channelStatus} />}
      <CategoryNav
        categories={categoriesWithProducts}
        activeId={activeId}
        onSelect={setActiveId}
      />
      <div className="space-y-3 p-4">
        {visibleProducts.map((product) => (
          <ProductCard key={product.id} product={product} currency={currency} disabled={closed} />
        ))}
      </div>
    </>
  );
}
