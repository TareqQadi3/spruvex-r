import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Label, Spinner, Textarea, cn } from "@spruvex-r/ui";
// Namespace import — see packages/ui/src/apply-theme.ts for why a named
// import of a const re-exported through @spruvex-r/types' barrel file
// breaks Vite/Rollup's static CJS-interop analysis.
import * as SpruvexTypes from "@spruvex-r/types";

import { api, ApiError } from "../../../lib/api";
import type { StepProps } from "./step-types";

const { RECEIPT_TEMPLATE_KEYS, RECEIPT_TEMPLATES, RECEIPT_LOGO_POSITIONS, RECEIPT_LOGO_SIZES } = SpruvexTypes;

const LOGO_POSITION_LABEL_KEY: Record<string, string> = {
  "top-center": "onboarding.logoPositionTop-center",
  "top-start": "onboarding.logoPositionTop-start",
  none: "onboarding.logoPositionNone",
};
const LOGO_SIZE_LABEL_KEY: Record<string, string> = {
  small: "onboarding.logoSizeSmall",
  medium: "onboarding.logoSizeMedium",
  large: "onboarding.logoSizeLarge",
};

interface TenantReceiptFields {
  receiptHeaderNote: string | null;
  receiptFooterNote: string | null;
  receiptTemplate: string;
  receiptLogoPosition: string;
  receiptLogoSize: string;
}

export function ReceiptStep({ onDone, onSkip }: StepProps) {
  const { t, i18n } = useTranslation();
  const [headerNote, setHeaderNote] = useState("");
  const [footerNote, setFooterNote] = useState("");
  const [template, setTemplate] = useState<string>("classic");
  const [logoPosition, setLogoPosition] = useState<string>("top-center");
  const [logoSize, setLogoSize] = useState<string>("medium");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<TenantReceiptFields>("/tenant")
      .then((tenant) => {
        setHeaderNote(tenant.receiptHeaderNote ?? "");
        setFooterNote(tenant.receiptFooterNote ?? "");
        setTemplate(tenant.receiptTemplate);
        setLogoPosition(tenant.receiptLogoPosition);
        setLogoSize(tenant.receiptLogoSize);
      })
      .finally(() => setLoading(false));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/tenant", {
        method: "PATCH",
        body: JSON.stringify({
          receiptHeaderNote: headerNote || null,
          receiptFooterNote: footerNote || null,
          receiptTemplate: template,
          receiptLogoPosition: logoPosition,
          receiptLogoSize: logoSize,
        }),
      });
      await onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <Spinner />;
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      {error && <Alert variant="destructive">{error}</Alert>}

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("onboarding.receiptTemplateLabel")}</legend>
        <p className="text-xs text-muted-foreground">{t("onboarding.receiptTemplateHint")}</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {RECEIPT_TEMPLATE_KEYS.map((key) => {
            const meta = RECEIPT_TEMPLATES[key];
            const name = i18n.language === "en" ? meta.nameEn : meta.nameAr;
            const description = i18n.language === "en" ? meta.descriptionEn : meta.descriptionAr;
            return (
              <button
                key={key}
                type="button"
                aria-pressed={template === key}
                onClick={() => setTemplate(key)}
                className={cn(
                  "rounded-lg border p-3 text-start text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  template === key ? "border-primary ring-2 ring-primary/40" : "border-input hover:bg-muted/40",
                )}
              >
                <span className="block font-medium">{name}</span>
                <span className="block text-xs text-muted-foreground">{description}</span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t("onboarding.receiptLogoPositionLabel")}</legend>
          <p className="text-xs text-muted-foreground">{t("onboarding.receiptLogoPositionHint")}</p>
          <select
            aria-label={t("onboarding.receiptLogoPositionLabel")}
            className="flex h-10 w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm"
            value={logoPosition}
            onChange={(e) => setLogoPosition(e.target.value)}
          >
            {RECEIPT_LOGO_POSITIONS.map((key) => (
              <option key={key} value={key}>
                {t(LOGO_POSITION_LABEL_KEY[key])}
              </option>
            ))}
          </select>
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t("onboarding.receiptLogoSizeLabel")}</legend>
          <p className="text-xs text-muted-foreground">{t("onboarding.receiptLogoSizeHint")}</p>
          <select
            aria-label={t("onboarding.receiptLogoSizeLabel")}
            className="flex h-10 w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm"
            value={logoSize}
            onChange={(e) => setLogoSize(e.target.value)}
            disabled={logoPosition === "none"}
          >
            {RECEIPT_LOGO_SIZES.map((key) => (
              <option key={key} value={key}>
                {t(LOGO_SIZE_LABEL_KEY[key])}
              </option>
            ))}
          </select>
        </fieldset>
      </div>

      <div className="space-y-2">
        <Label htmlFor="receipt-header">{t("onboarding.receiptHeaderNote")}</Label>
        <p className="text-xs text-muted-foreground">{t("onboarding.receiptHeaderNoteHint")}</p>
        <Textarea
          id="receipt-header"
          rows={2}
          value={headerNote}
          onChange={(e) => setHeaderNote(e.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="receipt-footer">{t("onboarding.receiptFooterNote")}</Label>
        <p className="text-xs text-muted-foreground">{t("onboarding.receiptFooterNoteHint")}</p>
        <Textarea
          id="receipt-footer"
          rows={2}
          value={footerNote}
          onChange={(e) => setFooterNote(e.target.value)}
        />
      </div>
      <div className="flex gap-3">
        <Button type="submit" className="flex-1" disabled={busy}>
          {busy ? <Spinner className="border-primary-foreground" /> : t("common.save")}
        </Button>
        <Button type="button" variant="outline" className="flex-1" onClick={() => void onSkip()} disabled={busy}>
          {t("onboarding.hubSkip")}
        </Button>
      </div>
    </form>
  );
}
