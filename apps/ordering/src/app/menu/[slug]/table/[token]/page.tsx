import { notFound } from "next/navigation";

import { CartProvider } from "@/components/CartProvider";
import { CartBar } from "@/components/CartBar";
import { LocaleProvider } from "@/components/LocaleProvider";
import { MenuHeader } from "@/components/MenuHeader";
import { MenuThemeStyle } from "@/components/MenuThemeStyle";
import { MenuView } from "@/components/MenuView";
import { apiGet, ApiError } from "@/lib/api";
import type { Locale } from "@/lib/dictionaries";
import type { Menu, TableInfo } from "@/lib/types";
import { menuScopeClassName } from "@/lib/menu-theme-scope";

export const dynamic = "force-dynamic";

export default async function TableMenuPage({
  params,
}: {
  params: Promise<{ slug: string; token: string }>;
}) {
  const { slug, token } = await params;

  let info: TableInfo;
  let menu: Menu;
  try {
    [info, menu] = await Promise.all([
      apiGet<TableInfo>(`/public/tables/${token}`),
      apiGet<Menu>(`/public/tables/${token}/menu`),
    ]);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 409)) {
      notFound();
    }
    throw error;
  }

  // Guard against a mismatched restaurant slug in the URL (defensive; the
  // token alone is authoritative, but this keeps shared links honest).
  if (info.restaurant.slug !== slug) {
    notFound();
  }

  return (
    <LocaleProvider initialLocale={info.restaurant.defaultLocale as Locale}>
      <CartProvider scope={`table:${token}`}>
        <div className={menuScopeClassName(info.restaurant.menuTemplate)}>
          <MenuThemeStyle template={info.restaurant.menuTemplate} customCss={info.restaurant.menuCustomCss} />
          <MenuHeader
            logoUrl={info.restaurant.logoUrl}
            name={info.restaurant.name}
            nameEn={info.restaurant.nameEn}
            subtitle={`${info.branch.name} · ${info.table.number}`}
          />
          <MenuView menu={menu} currency={info.restaurant.currency} channelStatus={info.channelStatus} />
          <CartBar
            href={`/menu/${slug}/table/${token}/cart`}
            currency={info.restaurant.currency}
            disabled={!info.channelStatus.open}
          />
        </div>
      </CartProvider>
    </LocaleProvider>
  );
}
