"use client";

import { CartPageContent } from "@/components/CartPageContent";
import { useLocale } from "@/components/LocaleProvider";
import { clientPost } from "@/lib/client-api";
import { saveLastOrder } from "@/lib/reorder";
import type { GuestOrderResult } from "@/lib/types";

export function PickupCartClient({
  slug,
  branchSlug,
  currency,
}: {
  slug: string;
  branchSlug: string;
  currency: string;
}) {
  const { t } = useLocale();

  return (
    <CartPageContent
      currency={currency}
      requirePhone
      notice={t("cart.pickupNotice")}
      onValidateCoupon={(code, subtotal) =>
        clientPost<{ discountAmount: string }>(
          `/public/restaurants/${slug}/branches/${branchSlug}/coupons/validate`,
          { code, channel: "takeaway", subtotal },
        )
      }
      onSubmit={async (ctx) => {
        const result = await clientPost<GuestOrderResult>(
          `/public/restaurants/${slug}/branches/${branchSlug}/orders`,
          {
            items: ctx.items,
            customerPhone: ctx.customerPhone,
            ...(ctx.customerName ? { customerName: ctx.customerName } : {}),
            ...(ctx.notes ? { notes: ctx.notes } : {}),
            ...(ctx.couponCode ? { couponCode: ctx.couponCode } : {}),
          },
          { "Idempotency-Key": crypto.randomUUID() },
        );
        saveLastOrder(`pickup:${slug}:${branchSlug}`, ctx.items);
        return result;
      }}
    />
  );
}
