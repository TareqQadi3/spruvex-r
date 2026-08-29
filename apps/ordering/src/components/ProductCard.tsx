"use client";

import { useState } from "react";

import { Badge, Button, Dialog, cn } from "@spruvex-r/ui";

import { useCart } from "./CartProvider";
import { useLocale, useLocalizedField } from "./LocaleProvider";
import type { MenuModifier, MenuProduct } from "@/lib/types";
import { formatMoney } from "@/lib/money";

export function ProductCard({ product, currency }: { product: MenuProduct; currency: string }) {
  const { t, locale } = useLocale();
  const name = useLocalizedField();
  const description =
    locale === "en" && product.descriptionEn ? product.descriptionEn : product.description;
  const { addLine } = useCart();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<MenuModifier[]>([]);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  function openPicker() {
    if (product.modifierGroups.length === 0) {
      addLine(product, []);
      return;
    }
    setSelected([]);
    setNotes("");
    setError(null);
    setOpen(true);
  }

  function confirm() {
    for (const group of product.modifierGroups) {
      const count = selected.filter((m) => group.modifiers.some((gm) => gm.id === m.id)).length;
      const min = group.isRequired ? Math.max(group.minSelect, 1) : group.minSelect;
      if (count < min) {
        setError(`${name(group)}: ${t("menu.chooseMin", { count: min })}`);
        return;
      }
      if (group.maxSelect != null && count > group.maxSelect) {
        setError(`${name(group)}: ${t("menu.chooseMax", { count: group.maxSelect })}`);
        return;
      }
    }
    addLine(product, selected, notes || undefined);
    setOpen(false);
  }

  return (
    <>
      <button
        type="button"
        data-menu-part="product-card"
        onClick={openPicker}
        className="flex w-full items-start gap-3 bg-card p-3 text-start transition-transform active:scale-[0.99]"
        style={{
          borderRadius: "var(--menu-card-radius, 0.75rem)",
          border: "var(--menu-card-border, 1px solid hsl(var(--border)))",
          boxShadow: "var(--menu-card-shadow, 0 1px 2px 0 rgb(0 0 0 / 0.05))",
        }}
      >
        {product.imageUrl && (
          <img
            data-menu-part="product-image"
            src={product.imageUrl}
            alt={name(product)}
            className="h-20 w-20 shrink-0 rounded-lg object-cover"
          />
        )}
        <div className="min-w-0 flex-1">
          <h3
            data-menu-part="product-name"
            className="leading-snug"
            style={{
              fontFamily: 'var(--menu-heading-font, "IBM Plex Sans Arabic", "Inter", system-ui, sans-serif)',
              fontWeight: "var(--menu-heading-weight, 600)",
            }}
          >
            {name(product)}
          </h3>
          {description && (
            <p data-menu-part="product-description" className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
              {description}
            </p>
          )}
          <p
            data-menu-part="product-price"
            className="mt-1.5 font-bold"
            dir="ltr"
            style={{ color: "hsl(var(--menu-primary, var(--primary)))" }}
          >
            {formatMoney(product.price, currency)}
          </p>
        </div>
      </button>

      <Dialog open={open} onClose={() => setOpen(false)} title={name(product)}>
        <div className="space-y-4">
          {error && (
            <p className="rounded-lg bg-destructive/10 p-2 text-sm text-destructive">{error}</p>
          )}
          {product.modifierGroups.map((group) => {
            const single = group.maxSelect === 1;
            return (
              <div key={group.id} className="space-y-2">
                <div className="flex items-center gap-2">
                  <h4 className="font-semibold">{name(group)}</h4>
                  {group.isRequired && <Badge variant="success">{t("menu.required")}</Badge>}
                </div>
                <div className="flex flex-wrap gap-2">
                  {group.modifiers.map((modifier) => {
                    const isSelected = selected.some((m) => m.id === modifier.id);
                    return (
                      <button
                        key={modifier.id}
                        type="button"
                        className={cn(
                          "rounded-full border-2 px-3 py-1.5 text-sm font-medium transition-colors",
                          isSelected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border bg-card",
                        )}
                        onClick={() =>
                          setSelected((current) => {
                            if (isSelected) return current.filter((m) => m.id !== modifier.id);
                            const withoutGroup = single
                              ? current.filter((m) => !group.modifiers.some((gm) => gm.id === m.id))
                              : current;
                            return [...withoutGroup, modifier];
                          })
                        }
                      >
                        {name(modifier)}
                        {Number(modifier.priceAdjustment) !== 0 && (
                          <span className="ms-1 text-xs" dir="ltr">
                            +{formatMoney(modifier.priceAdjustment, currency)}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
          <Button size="lg" className="w-full" onClick={confirm}>
            {t("menu.addToCart")}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
