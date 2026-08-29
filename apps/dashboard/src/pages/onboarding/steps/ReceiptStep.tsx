import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Label, Spinner, Textarea } from "@spruvex-r/ui";

import { api, ApiError } from "../../../lib/api";
import type { StepProps } from "./step-types";

export function ReceiptStep({ onDone, onSkip }: StepProps) {
  const { t } = useTranslation();
  const [headerNote, setHeaderNote] = useState("");
  const [footerNote, setFooterNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        }),
      });
      await onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && <Alert variant="destructive">{error}</Alert>}
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
