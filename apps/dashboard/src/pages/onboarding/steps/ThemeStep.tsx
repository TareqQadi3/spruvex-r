import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Spinner, applyThemeColor, cn } from "@spruvex-r/ui";
// Namespace import — see apply-theme.ts for why a named import of these
// consts (re-exported through the types package's barrel file) breaks
// Vite/Rollup's static CJS-interop analysis.
import * as SpruvexTypes from "@spruvex-r/types";
import type { ThemeColorKey } from "@spruvex-r/types";

import { api, ApiError } from "../../../lib/api";
import type { StepProps } from "./step-types";

const { THEME_PRESET_KEYS, THEME_PRESETS } = SpruvexTypes;

export function ThemeStep({ onDone, onSkip }: StepProps) {
  const { t, i18n } = useTranslation();
  const [selected, setSelected] = useState<ThemeColorKey>("green");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose(key: ThemeColorKey) {
    setSelected(key);
    setBusy(true);
    setError(null);
    try {
      await api("/tenant", { method: "PATCH", body: JSON.stringify({ themeColor: key }) });
      applyThemeColor(key);
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
      <p className="text-sm text-muted-foreground">{t("onboarding.themeStepSubtitle")}</p>
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
        {THEME_PRESET_KEYS.map((key) => {
          const preset = THEME_PRESETS[key];
          const name = i18n.language === "en" ? preset.nameEn : preset.nameAr;
          return (
            <button
              key={key}
              type="button"
              aria-pressed={selected === key}
              disabled={busy}
              onClick={() => void choose(key)}
              className={cn(
                "flex flex-col items-center gap-2 rounded-lg border p-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                selected === key ? "border-primary ring-2 ring-primary/40" : "border-input hover:bg-muted/40",
              )}
            >
              <span
                className="h-8 w-8 rounded-full border"
                style={{ backgroundColor: `hsl(${preset.primary})` }}
                aria-hidden="true"
              />
              {name}
            </button>
          );
        })}
      </div>
      <div className="flex gap-3">
        <Button type="button" variant="outline" className="flex-1" onClick={() => void onSkip()} disabled={busy}>
          {t("onboarding.hubSkip")}
        </Button>
        {busy && <Spinner />}
      </div>
    </div>
  );
}
