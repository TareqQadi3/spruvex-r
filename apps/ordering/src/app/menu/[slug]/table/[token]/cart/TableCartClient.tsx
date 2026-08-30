"use client";

import { useEffect, useState } from "react";

import { CartPageContent } from "@/components/CartPageContent";
import { useLocale } from "@/components/LocaleProvider";
import { clientPost } from "@/lib/client-api";
import type { GuestOrderResult } from "@/lib/types";

function phoneStorageKey(qrToken: string): string {
  return `spruvex:ordering:phone:table:${qrToken}`;
}

export function TableCartClient({ qrToken, currency }: { qrToken: string; currency: string }) {
  const { t } = useLocale();
  const [rememberedPhone, setRememberedPhone] = useState<string | undefined>(undefined);
  // Same SSR-safe pattern as CartProvider: localStorage doesn't exist on the
  // server, and CartPageContent's phone field only reads `initialPhone` on
  // its OWN first mount — so this must resolve BEFORE that mount, not in a
  // later effect that would arrive too late to matter.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      setRememberedPhone(localStorage.getItem(phoneStorageKey(qrToken)) ?? undefined);
    } catch {
      setRememberedPhone(undefined);
    }
    setReady(true);
  }, [qrToken]);

  if (!ready) return null;

  return (
    <CartPageContent
      currency={currency}
      requirePhone
      initialPhone={rememberedPhone}
      onPhoneChange={(phone) => {
        try {
          localStorage.setItem(phoneStorageKey(qrToken), phone);
        } catch {
          // best-effort convenience only — a full cart submit still works without it
        }
      }}
      notice={t("cart.dineInNotice")}
      onSubmit={async (ctx) => {
        const result = await clientPost<GuestOrderResult>(
          `/public/tables/${qrToken}/orders`,
          {
            items: ctx.items,
            customerPhone: ctx.customerPhone,
            ...(ctx.customerName ? { customerName: ctx.customerName } : {}),
            ...(ctx.notes ? { notes: ctx.notes } : {}),
          },
          { "Idempotency-Key": crypto.randomUUID() },
        );
        if (ctx.customerPhone) {
          try {
            localStorage.setItem(`spruvex:ordering:my-phone:order:${result.orderId}`, ctx.customerPhone);
          } catch {
            // cosmetic-only convenience — the order itself already succeeded
          }
        }
        return result;
      }}
    />
  );
}
