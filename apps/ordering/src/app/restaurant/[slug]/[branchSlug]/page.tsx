import { notFound } from "next/navigation";

import { CartBar } from "@/components/CartBar";
import { CartProvider } from "@/components/CartProvider";
import { LocaleProvider } from "@/components/LocaleProvider";
import { MenuHeader } from "@/components/MenuHeader";
import { MenuThemeStyle } from "@/components/MenuThemeStyle";
import { MenuView } from "@/components/MenuView";
import { apiGet, ApiError } from "@/lib/api";
import type { Locale } from "@/lib/dictionaries";
import type { Menu, RestaurantInfo } from "@/lib/types";
import { menuScopeClassName } from "@/lib/menu-theme-scope";

export const dynamic = "force-dynamic";

interface BranchMenuResponse extends Menu {
  branch: { name: string; nameEn: string | null; slug: string };
}

export default async function BranchMenuPage({
  params,
}: {
  params: Promise<{ slug: string; branchSlug: string }>;
}) {
  const { slug, branchSlug } = await params;

  let restaurant: RestaurantInfo;
  let menu: BranchMenuResponse;
  try {
    [restaurant, menu] = await Promise.all([
      apiGet<RestaurantInfo>(`/public/restaurants/${slug}`),
      apiGet<BranchMenuResponse>(`/public/restaurants/${slug}/branches/${branchSlug}/menu`),
    ]);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      notFound();
    }
    throw error;
  }

  return (
    <LocaleProvider initialLocale={restaurant.restaurant.defaultLocale as Locale}>
      <CartProvider scope={`pickup:${slug}:${branchSlug}`}>
        <div className={menuScopeClassName(restaurant.restaurant.menuTemplate)}>
          <MenuThemeStyle
            template={restaurant.restaurant.menuTemplate}
            customCss={restaurant.restaurant.menuCustomCss}
          />
          <MenuHeader
            logoUrl={restaurant.restaurant.logoUrl}
            name={restaurant.restaurant.name}
            nameEn={restaurant.restaurant.nameEn}
            subtitle={menu.branch.name}
          />
          <MenuView menu={menu} currency={restaurant.restaurant.currency} />
          <CartBar
            href={`/restaurant/${slug}/${branchSlug}/cart`}
            currency={restaurant.restaurant.currency}
          />
        </div>
      </CartProvider>
    </LocaleProvider>
  );
}
