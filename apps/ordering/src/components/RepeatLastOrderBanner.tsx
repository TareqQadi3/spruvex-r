"use client";

import { useEffect, useState } from "react";

import { useCart } from "./CartProvider";
import { useLocale, useLocalizedField } from "./LocaleProvider";
import { loadLastOrder, matchAgainstCurrentMenu, type RepeatableLine } from "@/lib/reorder";
import type { Menu } from "@/lib/types";

/**
 * "Repeat last order" — tied to THIS browser/device via localStorage, never
 * a server-side lookup by phone number (which would leak one customer's
 * order history to anyone who guesses/knows their number). Items are
 * re-matched against the CURRENT menu, never the stale cached snapshot —
 * anything deleted, disabled, or no longer satisfying its product's
 * required-option rules is silently dropped.
 */
export function RepeatLastOrderBanner({ scope, menu }: { scope: string; menu: Menu }) {
  const { t } = useLocale();
  const name = useLocalizedField();
  const { addLines } = useCart();
  const [lines, setLines] = useState<RepeatableLine[] | null>(null);
  const [added, setAdded] = useState(false);

  useEffect(() => {
    const record = loadLastOrder(scope);
    if (!record) return;
    const matched = matchAgainstCurrentMenu(record, menu);
    if (matched.length > 0) setLines(matched);
    // Intentionally runs once per mount — the menu/scope identify a fixed page.
  }, []);

  if (!lines || lines.length === 0) return null;

  const summary = lines.map((l) => `${name(l.product)}${l.quantity > 1 ? ` ×${l.quantity}` : ""}`).join("، ");

  return (
    <div className="mx-4 mt-3 flex items-center justify-between gap-3 rounded-xl border bg-card p-3">
      <div className="min-w-0">
        <p className="text-sm font-semibold">{t("cart.repeatLastOrder")}</p>
        <p className="truncate text-xs text-muted-foreground">{summary}</p>
      </div>
      {added ? (
        <span className="shrink-0 text-xs font-medium text-primary">{t("cart.repeatAdded")}</span>
      ) : (
        <button
          type="button"
          className="shrink-0 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground"
          onClick={() => {
            addLines(lines);
            setAdded(true);
          }}
        >
          {t("cart.repeatAdd")}
        </button>
      )}
    </div>
  );
}
