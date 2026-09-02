"use client";

import Link from "next/link";

import { Button } from "@spruvex-r/ui";

import { useCart } from "./CartProvider";
import { useLocale } from "./LocaleProvider";
import { cartItemCount, cartTotal } from "@/lib/cart";
import { formatMoney } from "@/lib/money";

export function CartBar({
  href,
  currency,
  disabled,
}: {
  href: string;
  currency: string;
  disabled?: boolean;
}) {
  const { lines } = useCart();
  const { t } = useLocale();
  const count = cartItemCount(lines);

  if (count === 0) return null;

  if (disabled) {
    return (
      <div className="sticky bottom-0 z-20 border-t bg-card p-3 shadow-[0_-4px_12px_rgba(0,0,0,0.06)]">
        <Button size="lg" className="w-full" disabled>
          {t("menu.closedNow")}
        </Button>
      </div>
    );
  }

  return (
    <div className="sticky bottom-0 z-20 border-t bg-card p-3 shadow-[0_-4px_12px_rgba(0,0,0,0.06)]">
      <Link href={href}>
        <Button size="lg" className="flex w-full items-center justify-between text-base">
          <span>
            {t("menu.viewCart")} · {count}
          </span>
          <span dir="ltr">{formatMoney(cartTotal(lines), currency)}</span>
        </Button>
      </Link>
    </div>
  );
}
