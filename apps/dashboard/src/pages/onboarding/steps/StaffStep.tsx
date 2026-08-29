import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Input, Spinner } from "@spruvex-r/ui";

import { ApiError, post } from "../../../lib/api";
import type { StepProps } from "./step-types";

const emptyStaff = { name: "", email: "", password: "" };

export function StaffStep({ onDone, onSkip }: StepProps) {
  const { t } = useTranslation();
  const [manager, setManager] = useState({ ...emptyStaff });
  const [cashier, setCashier] = useState({ ...emptyStaff });
  const [kitchen, setKitchen] = useState({ ...emptyStaff });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const users = [
      ...(manager.email ? [{ ...manager, role: "manager" as const }] : []),
      ...(cashier.email ? [{ ...cashier, role: "cashier" as const }] : []),
      ...(kitchen.email ? [{ ...kitchen, role: "kitchen" as const }] : []),
    ];
    if (users.length === 0) {
      await onSkip();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await post("/onboarding/staff", { users });
      await onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-6">
      {error && <Alert variant="destructive">{error}</Alert>}
      <p className="text-sm text-muted-foreground">{t("onboarding.staffHint")}</p>
      <Alert>{t("onboarding.staffKitchenHint")}</Alert>
      {(
        [
          { key: "staffManager", state: manager, set: setManager },
          { key: "staffCashier", state: cashier, set: setCashier },
          { key: "staffKitchen", state: kitchen, set: setKitchen },
        ] as const
      ).map(({ key, state, set }) => (
        <fieldset key={key} className="space-y-3 rounded-lg border p-4">
          <legend className="px-2 text-sm font-semibold">{t(`onboarding.${key}`)}</legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Input
              aria-label={t("auth.name")}
              placeholder={t("auth.name")}
              value={state.name}
              onChange={(e) => set({ ...state, name: e.target.value })}
            />
            <Input
              aria-label={t("auth.email")}
              placeholder={t("auth.email")}
              dir="ltr"
              type="email"
              value={state.email}
              onChange={(e) => set({ ...state, email: e.target.value })}
            />
            <Input
              aria-label={t("auth.password")}
              placeholder={t("auth.password")}
              dir="ltr"
              type="password"
              value={state.password}
              onChange={(e) => set({ ...state, password: e.target.value })}
            />
          </div>
        </fieldset>
      ))}
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
