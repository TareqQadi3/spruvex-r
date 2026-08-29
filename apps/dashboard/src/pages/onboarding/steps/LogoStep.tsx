import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, ImageInput, Spinner } from "@spruvex-r/ui";

import { api, ApiError, uploadImage } from "../../../lib/api";
import type { StepProps } from "./step-types";

export function LogoStep({ onDone, onSkip }: StepProps) {
  const { t } = useTranslation();
  const [logoUrl, setLogoUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!logoUrl) return;
    setBusy(true);
    setError(null);
    try {
      await api("/tenant", { method: "PATCH", body: JSON.stringify({ logoUrl }) });
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
      <ImageInput
        label={t("onboarding.logoStepTitle")}
        hint={t("onboarding.logoStepSubtitle")}
        value={logoUrl}
        onChange={setLogoUrl}
        onUploadFile={uploadImage}
        uploadTabLabel={t("common.uploadTab")}
        urlTabLabel={t("common.urlTab")}
        uploadButtonLabel={t("common.uploadButton")}
        removeLabel={t("common.removeImage")}
        errorFallback={t("common.uploadError")}
        constraintsHint={t("common.imageConstraints")}
      />
      <div className="flex gap-3">
        <Button type="submit" className="flex-1" disabled={busy || !logoUrl}>
          {busy ? <Spinner className="border-primary-foreground" /> : t("common.save")}
        </Button>
        <Button type="button" variant="outline" className="flex-1" onClick={() => void onSkip()} disabled={busy}>
          {t("onboarding.hubSkip")}
        </Button>
      </div>
    </form>
  );
}
