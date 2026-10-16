import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { Alert, Button, Spinner, Switch } from "@spruvex-r/ui";

import { api, ApiError } from "../../../lib/api";
import type { StepProps } from "./step-types";

interface ZatcaSettings {
  enabled: boolean;
  environment: "sandbox" | "simulation" | "production";
}

export function ZatcaStep({ onDone, onSkip }: StepProps) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api<ZatcaSettings>("/tenant/zatca-settings", {
        method: "PATCH",
        body: JSON.stringify({ enabled, environment: "sandbox" }),
      });
      await onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {error && <Alert variant="destructive">{error}</Alert>}
      <p className="text-sm text-muted-foreground">{t("onboarding.zatcaStepSubtitle")}</p>
      <div className="flex items-center gap-3 rounded-lg border p-4">
        <Switch checked={enabled} aria-label={t("settings.zatcaPhase2Enable")} onCheckedChange={setEnabled} />
        <span className="text-sm font-medium">{t("settings.zatcaPhase2Enable")}</span>
      </div>
      {enabled && (
        <Alert>
          {t("settings.zatcaPhase2Hint")}{" "}
          <Link to="/settings" className="font-medium underline">
            {t("nav.settings")}
          </Link>
        </Alert>
      )}
      <div className="flex gap-3">
        <Button type="button" className="flex-1" onClick={() => void save()} disabled={busy}>
          {busy ? <Spinner className="border-primary-foreground" /> : t("common.save")}
        </Button>
        <Button type="button" variant="outline" className="flex-1" onClick={() => void onSkip()} disabled={busy}>
          {t("onboarding.hubSkip")}
        </Button>
      </div>
    </div>
  );
}
