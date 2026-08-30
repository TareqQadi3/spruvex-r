"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Input, Spinner, Textarea } from "@spruvex-r/ui";

import { useCart } from "./CartProvider";
import { useLocale, useLocalizedField } from "./LocaleProvider";
import { cartTotal, lineTotal, lineUnitPrice } from "@/lib/cart";
import { formatMoney } from "@/lib/money";
import { ApiError } from "@/lib/api";
import type { CartLineInput, GuestOrderResult } from "@/lib/types";

export interface CartSubmitContext {
  notes: string;
  customerName: string;
  customerPhone?: string;
  items: CartLineInput[];
}

export function CartPageContent({
  currency,
  requirePhone,
  notice,
  onSubmit,
  initialPhone,
  onPhoneChange,
}: {
  currency: string;
  /** Pickup orders and shared table-session orders both require a phone
   * number — it's the identity, not just a delivery contact. */
  requirePhone: boolean;
  notice: string;
  onSubmit: (ctx: CartSubmitContext) => Promise<GuestOrderResult>;
  /** Pre-fills the phone field (e.g. remembered from this device's last
   * round at this table) so returning to order more doesn't mean retyping it. */
  initialPhone?: string;
  onPhoneChange?: (phone: string) => void;
}) {
  const { t } = useLocale();
  const name = useLocalizedField();
  const router = useRouter();
  const { lines, removeLine, setQuantity, clear } = useCart();

  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState(initialPhone ?? "");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Set right before clearing the cart post-submit so this component doesn't
  // flash the "cart is empty" fallback while router.push is still navigating
  // away to the order tracking page.
  const [submitted, setSubmitted] = useState(false);

  async function submit() {
    if (lines.length === 0 || busy) return;
    if (requirePhone && !customerPhone) {
      setError(t("cart.phoneRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await onSubmit({
        notes,
        customerName,
        ...(requirePhone ? { customerPhone } : {}),
        items: lines.map((line) => ({
          productId: line.product.id,
          quantity: line.quantity,
          ...(line.modifiers.length > 0
            ? { modifierIds: line.modifiers.map((m) => m.id) }
            : {}),
          ...(line.notes ? { notes: line.notes } : {}),
        })),
      });
      setSubmitted(true);
      clear();
      router.push(`/order/${result.orderId}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("common.error"));
      setBusy(false);
    }
  }

  if (lines.length === 0 && !submitted) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-4xl">🛒</p>
        <p className="text-muted-foreground">{t("cart.empty")}</p>
        <Button variant="outline" onClick={() => router.back()}>
          {t("cart.backToMenu")}
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg space-y-4 p-4 pb-40">
      <h1 className="text-xl font-bold">{t("cart.title")}</h1>

      <div className="space-y-3">
        {lines.map((line) => (
          <div key={line.lineId} className="rounded-xl border bg-card p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-semibold">{name(line.product)}</p>
                {line.modifiers.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {line.modifiers.map((m) => name(m)).join("، ")}
                  </p>
                )}
                <p className="mt-1 text-sm font-medium text-primary" dir="ltr">
                  {formatMoney(lineUnitPrice(line), currency)}
                </p>
              </div>
              <button
                type="button"
                className="text-xs text-destructive underline"
                onClick={() => removeLine(line.lineId)}
              >
                {t("cart.remove")}
              </button>
            </div>
            <div className="mt-2 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  className="flex h-8 w-8 items-center justify-center rounded-full border text-lg font-bold"
                  onClick={() => setQuantity(line.lineId, line.quantity - 1)}
                >
                  −
                </button>
                <span className="w-5 text-center font-bold" dir="ltr">
                  {line.quantity}
                </span>
                <button
                  type="button"
                  className="flex h-8 w-8 items-center justify-center rounded-full border text-lg font-bold"
                  onClick={() => setQuantity(line.lineId, line.quantity + 1)}
                >
                  +
                </button>
              </div>
              <span className="font-bold" dir="ltr">
                {formatMoney(lineTotal(line), currency)}
              </span>
            </div>
          </div>
        ))}
      </div>

      <div className="space-y-3 rounded-xl border bg-card p-3">
        <Input
          placeholder={t("cart.yourName")}
          value={customerName}
          onChange={(e) => setCustomerName(e.target.value)}
        />
        {requirePhone && (
          <Input
            dir="ltr"
            type="tel"
            placeholder={t("cart.phone")}
            value={customerPhone}
            onChange={(e) => {
              setCustomerPhone(e.target.value);
              onPhoneChange?.(e.target.value);
            }}
            required
          />
        )}
        <Textarea
          placeholder={t("cart.notes")}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>

      <p className="text-center text-sm text-muted-foreground">{notice}</p>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-card p-4 shadow-[0_-4px_12px_rgba(0,0,0,0.08)]">
        <div className="mx-auto max-w-lg space-y-3">
          {error && <Alert variant="destructive">{error}</Alert>}
          <div className="flex items-center justify-between text-lg font-bold">
            <span>{t("cart.total")}</span>
            <span dir="ltr">{formatMoney(cartTotal(lines), currency)}</span>
          </div>
          <Button size="lg" className="w-full text-base" disabled={busy} onClick={submit}>
            {busy ? <Spinner className="border-primary-foreground" /> : t("cart.submit")}
          </Button>
        </div>
      </div>
    </div>
  );
}
