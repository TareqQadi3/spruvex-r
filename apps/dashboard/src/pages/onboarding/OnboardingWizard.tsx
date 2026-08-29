import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Spinner,
  cn,
} from "@spruvex-r/ui";

import { ApiError, api, post } from "../../lib/api";
import { useAuth } from "../../lib/auth";

const RESTAURANT_TYPES = ["restaurant", "cafe", "cloud_kitchen", "food_truck", "bakery", "other"];

type WizardStep = 2 | 3 | 4 | 5;

interface StatusResponse {
  step: WizardStep | "done";
}

/** Wizard steps 2-5 (step 1 = registration). */
export function OnboardingWizard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { adoptSession, refreshProfile } = useAuth();

  const [step, setStep] = useState<WizardStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<StatusResponse>("/onboarding/status")
      .then((s) => {
        if (s.step === "done") {
          navigate("/", { replace: true });
        } else {
          setStep(s.step);
        }
      })
      .catch(() => setStep(2));
  }, [navigate]);

  async function run(fn: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  // --- step 2: restaurant info ---
  const [restaurant, setRestaurant] = useState({
    name: "",
    nameEn: "",
    type: "restaurant",
    country: "SA",
    currency: "SAR",
    defaultLocale: "ar",
    logoUrl: "",
  });

  function submitRestaurant(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const res = await post<{ tenantId: string; tokens: { accessToken: string; refreshToken: string } }>(
        "/onboarding/restaurant",
        {
          name: restaurant.name,
          ...(restaurant.nameEn ? { nameEn: restaurant.nameEn } : {}),
          type: restaurant.type,
          country: restaurant.country,
          currency: restaurant.currency,
          defaultLocale: restaurant.defaultLocale,
          ...(restaurant.logoUrl ? { logoUrl: restaurant.logoUrl } : {}),
        },
      );
      await adoptSession(res.tokens); // tokens now carry the tenant + owner permissions
      setStep(3);
    });
  }

  // --- step 3: first branch ---
  const [branch, setBranch] = useState({ name: "", address: "", phone: "", email: "" });

  function submitBranch(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      await post("/onboarding/branch", {
        name: branch.name,
        ...(branch.address ? { address: branch.address } : {}),
        ...(branch.phone ? { phone: branch.phone } : {}),
        ...(branch.email ? { email: branch.email } : {}),
      });
      setStep(4);
    });
  }

  // --- step 4: first users ---
  const emptyStaff = { name: "", email: "", password: "" };
  const [manager, setManager] = useState({ ...emptyStaff });
  const [cashier, setCashier] = useState({ ...emptyStaff });
  const [kitchen, setKitchen] = useState({ ...emptyStaff });

  function submitStaff(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const users = [
        ...(manager.email ? [{ ...manager, role: "manager" as const }] : []),
        ...(cashier.email ? [{ ...cashier, role: "cashier" as const }] : []),
        ...(kitchen.email ? [{ ...kitchen, role: "kitchen" as const }] : []),
      ];
      if (users.length > 0) {
        await post("/onboarding/staff", { users });
      }
      setStep(5);
    });
  }

  // --- step 5: complete ---
  function complete() {
    void run(async () => {
      await post("/onboarding/complete", {});
      await refreshProfile();
      navigate("/", { replace: true });
    });
  }

  if (step === null) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  const steps: Array<{ n: WizardStep; key: string }> = [
    { n: 2, key: "restaurantStep" },
    { n: 3, key: "branchStep" },
    { n: 4, key: "staffStep" },
    { n: 5, key: "completeStep" },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-b from-secondary/60 to-background p-4">
      <div className="mx-auto max-w-2xl py-8">
        <div className="mb-6 flex items-center justify-center gap-2">
          <img src="/logo-horizontal.png" alt="SpruVex R" className="h-12 object-contain" />
        </div>

        {/* progress */}
        <ol className="mb-6 flex items-center justify-center gap-2">
          {steps.map(({ n, key }, idx) => (
            <li key={n} className="flex items-center gap-2">
              <span
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold",
                  step >= n ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
                )}
              >
                {idx + 1}
              </span>
              <span
                className={cn(
                  "hidden text-sm sm:inline",
                  step >= n ? "font-medium" : "text-muted-foreground",
                )}
              >
                {t(`onboarding.${key}`)}
              </span>
              {idx < steps.length - 1 && <span className="mx-1 h-px w-6 bg-border" />}
            </li>
          ))}
        </ol>

        <Card>
          <CardHeader>
            <CardTitle>{t("onboarding.title")}</CardTitle>
            <CardDescription>
              {t("onboarding.step", { current: step - 1, total: 4 })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {error && <Alert variant="destructive" className="mb-4">{error}</Alert>}

            {step === 2 && (
              <form onSubmit={submitRestaurant} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="rname">{t("onboarding.restaurantName")}</Label>
                  <Input
                    id="rname"
                    required
                    value={restaurant.name}
                    onChange={(e) => setRestaurant({ ...restaurant, name: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="rnameEn">{t("onboarding.restaurantNameEn")}</Label>
                  <Input
                    id="rnameEn"
                    dir="ltr"
                    value={restaurant.nameEn}
                    onChange={(e) => setRestaurant({ ...restaurant, nameEn: e.target.value })}
                  />
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="rtype">{t("onboarding.type")}</Label>
                    <select
                      id="rtype"
                      className="flex h-10 w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm"
                      value={restaurant.type}
                      onChange={(e) => setRestaurant({ ...restaurant, type: e.target.value })}
                    >
                      {RESTAURANT_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {t(`onboarding.types.${type}`)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="rlocale">{t("onboarding.defaultLocale")}</Label>
                    <select
                      id="rlocale"
                      className="flex h-10 w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm"
                      value={restaurant.defaultLocale}
                      onChange={(e) => setRestaurant({ ...restaurant, defaultLocale: e.target.value })}
                    >
                      <option value="ar">العربية</option>
                      <option value="en">English</option>
                    </select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="rcountry">{t("onboarding.country")}</Label>
                    <Input
                      id="rcountry"
                      dir="ltr"
                      maxLength={2}
                      value={restaurant.country}
                      onChange={(e) =>
                        setRestaurant({ ...restaurant, country: e.target.value.toUpperCase() })
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="rcurrency">{t("onboarding.currency")}</Label>
                    <Input
                      id="rcurrency"
                      dir="ltr"
                      maxLength={3}
                      value={restaurant.currency}
                      onChange={(e) =>
                        setRestaurant({ ...restaurant, currency: e.target.value.toUpperCase() })
                      }
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="rlogo">{t("onboarding.logoUrl")}</Label>
                  <Input
                    id="rlogo"
                    dir="ltr"
                    type="url"
                    value={restaurant.logoUrl}
                    onChange={(e) => setRestaurant({ ...restaurant, logoUrl: e.target.value })}
                  />
                </div>
                <Button type="submit" className="w-full" disabled={busy}>
                  {busy ? <Spinner className="border-primary-foreground" /> : t("common.next")}
                </Button>
              </form>
            )}

            {step === 3 && (
              <form onSubmit={submitBranch} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="bname">{t("onboarding.branchName")}</Label>
                  <Input
                    id="bname"
                    required
                    value={branch.name}
                    onChange={(e) => setBranch({ ...branch, name: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="baddress">{t("onboarding.branchAddress")}</Label>
                  <Input
                    id="baddress"
                    value={branch.address}
                    onChange={(e) => setBranch({ ...branch, address: e.target.value })}
                  />
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="bphone">{t("onboarding.branchPhone")}</Label>
                    <Input
                      id="bphone"
                      dir="ltr"
                      type="tel"
                      placeholder="+9665xxxxxxxx"
                      value={branch.phone}
                      onChange={(e) => setBranch({ ...branch, phone: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="bemail">{t("onboarding.branchEmail")}</Label>
                    <Input
                      id="bemail"
                      dir="ltr"
                      type="email"
                      value={branch.email}
                      onChange={(e) => setBranch({ ...branch, email: e.target.value })}
                    />
                  </div>
                </div>
                <Button type="submit" className="w-full" disabled={busy}>
                  {busy ? <Spinner className="border-primary-foreground" /> : t("common.next")}
                </Button>
              </form>
            )}

            {step === 4 && (
              <form onSubmit={submitStaff} className="space-y-6">
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
                        placeholder={t("auth.name")}
                        value={state.name}
                        onChange={(e) => set({ ...state, name: e.target.value })}
                      />
                      <Input
                        placeholder={t("auth.email")}
                        dir="ltr"
                        type="email"
                        value={state.email}
                        onChange={(e) => set({ ...state, email: e.target.value })}
                      />
                      <Input
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
                    {busy ? <Spinner className="border-primary-foreground" /> : t("common.next")}
                  </Button>
                  <Button type="button" variant="outline" onClick={() => setStep(5)} disabled={busy}>
                    {t("common.skip")}
                  </Button>
                </div>
              </form>
            )}

            {step === 5 && (
              <div className="space-y-4 py-4 text-center">
                <div className="text-5xl">🎉</div>
                <h3 className="text-xl font-semibold">{t("onboarding.completeTitle")}</h3>
                <p className="text-muted-foreground">{t("onboarding.completeSubtitle")}</p>
                <Button size="lg" className="w-full" onClick={complete} disabled={busy}>
                  {busy ? <Spinner className="border-primary-foreground" /> : t("onboarding.enterDashboard")}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
