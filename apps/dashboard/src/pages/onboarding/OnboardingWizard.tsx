import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";

import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Spinner,
} from "@spruvex-r/ui";

import { ApiError, api, post } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { LogoStep } from "./steps/LogoStep";
import { MenuStep } from "./steps/MenuStep";
import { ReceiptStep } from "./steps/ReceiptStep";
import { StaffStep } from "./steps/StaffStep";
import type { StepProps } from "./steps/step-types";
import { ThemeStep } from "./steps/ThemeStep";
import { ZatcaStep } from "./steps/ZatcaStep";

const RESTAURANT_TYPES = ["restaurant", "cafe", "cloud_kitchen", "food_truck", "bakery", "other"];

/** Mirrors apps/api's OPTIONAL_SETUP_STEPS — the hub's cards. */
const HUB_STEPS = ["logo", "receipt", "theme", "zatca", "staff", "menu", "tables"] as const;
type HubStep = (typeof HUB_STEPS)[number];

/** Hub cards with an inline mini-form; "tables" is a link out to its real page instead. */
const INLINE_STEPS: Partial<Record<HubStep, (props: StepProps) => JSX.Element>> = {
  logo: LogoStep,
  receipt: ReceiptStep,
  theme: ThemeStep,
  zatca: ZatcaStep,
  staff: StaffStep,
  menu: MenuStep,
};

interface SetupStatusItem {
  step: HubStep;
  done: boolean;
  skipped: boolean;
}

type BasicStep = 2 | 3 | 4 | 5;
interface StatusResponse {
  step: BasicStep | "done";
}

type View = "welcome" | "language" | "mandatory" | "branch" | "hub" | HubStep;

export function OnboardingWizard() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { adoptSession, refreshProfile } = useAuth();

  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [setupStatus, setSetupStatus] = useState<SetupStatusItem[] | null>(null);

  const jumpTo = searchParams.get("step");

  useEffect(() => {
    api<StatusResponse>("/onboarding/status")
      .then((s) => {
        if (s.step === "done") {
          navigate("/", { replace: true });
        } else if (s.step === 2) {
          setView("welcome");
        } else if (s.step === 3) {
          setView("branch");
        } else if (jumpTo && (HUB_STEPS as readonly string[]).includes(jumpTo)) {
          setView(jumpTo as HubStep);
        } else {
          setView("hub");
        }
      })
      .catch(() => setView("welcome"));
  }, [navigate, jumpTo]);

  useEffect(() => {
    if (view === "hub") {
      api<SetupStatusItem[]>("/onboarding/setup-status")
        .then(setSetupStatus)
        .catch(() => setSetupStatus(null));
    }
  }, [view]);

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

  async function markStep(step: HubStep, status: "done" | "skipped") {
    try {
      await post("/onboarding/setup-status", { step, status });
    } catch {
      // best-effort — the hub still re-fetches and the owner can retry from there
    }
    setView("hub");
  }

  // --- language ---
  const [language, setLanguage] = useState<"ar" | "en">(i18n.language === "en" ? "en" : "ar");

  function chooseLanguage(lang: "ar" | "en") {
    setLanguage(lang);
    void i18n.changeLanguage(lang);
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
    document.documentElement.lang = lang;
    setView("mandatory");
  }

  // --- mandatory restaurant + tax-invoice info ---
  const [restaurant, setRestaurant] = useState({
    name: "",
    type: "restaurant",
    vatNumber: "",
    crNumber: "",
    address: "",
    city: "",
    district: "",
    buildingNumber: "",
    postalCode: "",
    additionalAddress: "",
    contactPhone: "",
  });

  function submitRestaurant(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const res = await post<{ tenantId: string; tokens: { accessToken: string; refreshToken: string } }>(
        "/onboarding/restaurant",
        { ...restaurant, defaultLocale: language, country: "SA", currency: "SAR" },
      );
      await adoptSession(res.tokens);
      setView("branch");
    });
  }

  // --- first branch (kept mandatory — a tenant needs at least one) ---
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
      setView("hub");
    });
  }

  // --- finish ---
  function complete() {
    void run(async () => {
      await post("/onboarding/complete", {});
      await refreshProfile();
      navigate("/", { replace: true });
    });
  }

  if (view === null) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-secondary/60 to-background p-4">
      <div className="mx-auto max-w-2xl py-8">
        <div className="mb-6 flex items-center justify-center gap-2">
          <img src="/logo-horizontal.png" alt="SpruVex R" className="h-12 object-contain" />
        </div>

        {view === "welcome" && (
          <Card>
            <CardContent className="space-y-6 py-10 text-center">
              <div className="text-5xl">👋</div>
              <h1 className="text-2xl font-semibold">{t("onboarding.welcomeTitle")}</h1>
              <p className="text-muted-foreground">{t("onboarding.welcomeSubtitle")}</p>
              <Button size="lg" className="w-full" onClick={() => setView("language")}>
                {t("onboarding.welcomeStart")}
              </Button>
            </CardContent>
          </Card>
        )}

        {view === "language" && (
          <Card>
            <CardHeader>
              <CardTitle>{t("onboarding.languageTitle")}</CardTitle>
              <CardDescription>{t("onboarding.languageSubtitle")}</CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-4">
              <Button size="lg" variant="outline" onClick={() => chooseLanguage("ar")}>
                {t("onboarding.languageAr")}
              </Button>
              <Button size="lg" variant="outline" onClick={() => chooseLanguage("en")}>
                {t("onboarding.languageEn")}
              </Button>
            </CardContent>
          </Card>
        )}

        {view === "mandatory" && (
          <Card>
            <CardHeader>
              <CardTitle>{t("onboarding.mandatoryTitle")}</CardTitle>
              <CardDescription>{t("onboarding.mandatorySubtitle")}</CardDescription>
            </CardHeader>
            <CardContent>
              {error && (
                <Alert variant="destructive" className="mb-4">
                  {error}
                </Alert>
              )}
              <form onSubmit={submitRestaurant} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="rname">{t("onboarding.restaurantName")}</Label>
                  <p className="text-xs text-muted-foreground">{t("onboarding.restaurantNameHint")}</p>
                  <Input
                    id="rname"
                    required
                    value={restaurant.name}
                    onChange={(e) => setRestaurant({ ...restaurant, name: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="rtype">{t("onboarding.type")}</Label>
                  <p className="text-xs text-muted-foreground">{t("onboarding.typeHint")}</p>
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
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="rvat">{t("onboarding.vatNumber")}</Label>
                    <p className="text-xs text-muted-foreground">{t("onboarding.vatNumberHint")}</p>
                    <Input
                      id="rvat"
                      required
                      dir="ltr"
                      inputMode="numeric"
                      value={restaurant.vatNumber}
                      onChange={(e) => setRestaurant({ ...restaurant, vatNumber: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="rcr">{t("onboarding.crNumber")}</Label>
                    <p className="text-xs text-muted-foreground">{t("onboarding.crNumberHint")}</p>
                    <Input
                      id="rcr"
                      required
                      dir="ltr"
                      value={restaurant.crNumber}
                      onChange={(e) => setRestaurant({ ...restaurant, crNumber: e.target.value })}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="raddress">{t("onboarding.address")}</Label>
                  <p className="text-xs text-muted-foreground">{t("onboarding.addressHint")}</p>
                  <Input
                    id="raddress"
                    required
                    value={restaurant.address}
                    onChange={(e) => setRestaurant({ ...restaurant, address: e.target.value })}
                  />
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="rcity">{t("onboarding.city")}</Label>
                    <p className="text-xs text-muted-foreground">{t("onboarding.cityHint")}</p>
                    <Input
                      id="rcity"
                      required
                      value={restaurant.city}
                      onChange={(e) => setRestaurant({ ...restaurant, city: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="rdistrict">{t("onboarding.district")}</Label>
                    <p className="text-xs text-muted-foreground">{t("onboarding.districtHint")}</p>
                    <Input
                      id="rdistrict"
                      required
                      value={restaurant.district}
                      onChange={(e) => setRestaurant({ ...restaurant, district: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="rbuilding">{t("onboarding.buildingNumber")}</Label>
                    <p className="text-xs text-muted-foreground">{t("onboarding.buildingNumberHint")}</p>
                    <Input
                      id="rbuilding"
                      required
                      dir="ltr"
                      inputMode="numeric"
                      maxLength={4}
                      value={restaurant.buildingNumber}
                      onChange={(e) => setRestaurant({ ...restaurant, buildingNumber: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="rpostal">{t("onboarding.postalCode")}</Label>
                    <p className="text-xs text-muted-foreground">{t("onboarding.postalCodeHint")}</p>
                    <Input
                      id="rpostal"
                      required
                      dir="ltr"
                      inputMode="numeric"
                      maxLength={5}
                      value={restaurant.postalCode}
                      onChange={(e) => setRestaurant({ ...restaurant, postalCode: e.target.value })}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="raddition">{t("onboarding.additionalAddress")}</Label>
                  <p className="text-xs text-muted-foreground">{t("onboarding.additionalAddressHint")}</p>
                  <Input
                    id="raddition"
                    required
                    value={restaurant.additionalAddress}
                    onChange={(e) => setRestaurant({ ...restaurant, additionalAddress: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="rphone">{t("onboarding.contactPhone")}</Label>
                  <p className="text-xs text-muted-foreground">{t("onboarding.contactPhoneHint")}</p>
                  <Input
                    id="rphone"
                    required
                    dir="ltr"
                    type="tel"
                    placeholder="+9665xxxxxxxx"
                    value={restaurant.contactPhone}
                    onChange={(e) => setRestaurant({ ...restaurant, contactPhone: e.target.value })}
                  />
                </div>
                <Button type="submit" className="w-full" disabled={busy}>
                  {busy ? <Spinner className="border-primary-foreground" /> : t("common.next")}
                </Button>
              </form>
            </CardContent>
          </Card>
        )}

        {view === "branch" && (
          <Card>
            <CardHeader>
              <CardTitle>{t("onboarding.branchStep")}</CardTitle>
            </CardHeader>
            <CardContent>
              {error && (
                <Alert variant="destructive" className="mb-4">
                  {error}
                </Alert>
              )}
              <form onSubmit={submitBranch} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="bname">{t("onboarding.branchName")}</Label>
                  <p className="text-xs text-muted-foreground">{t("onboarding.branchNameHint")}</p>
                  <Input
                    id="bname"
                    required
                    value={branch.name}
                    onChange={(e) => setBranch({ ...branch, name: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="baddress">{t("onboarding.branchAddress")}</Label>
                  <p className="text-xs text-muted-foreground">{t("onboarding.branchAddressHint")}</p>
                  <Input
                    id="baddress"
                    value={branch.address}
                    onChange={(e) => setBranch({ ...branch, address: e.target.value })}
                  />
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="bphone">{t("onboarding.branchPhone")}</Label>
                    <p className="text-xs text-muted-foreground">{t("onboarding.branchPhoneHint")}</p>
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
                    <p className="text-xs text-muted-foreground">{t("onboarding.branchEmailHint")}</p>
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
            </CardContent>
          </Card>
        )}

        {view === "hub" && (
          <Card>
            <CardHeader>
              <CardTitle>{t("onboarding.hubTitle")}</CardTitle>
              <CardDescription>{t("onboarding.hubSubtitle")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {setupStatus === null ? (
                <Spinner />
              ) : (
                HUB_STEPS.map((key) => {
                  const status = setupStatus.find((s) => s.step === key);
                  const badge = status?.done ? "done" : status?.skipped ? "skipped" : "pending";
                  return (
                    <div
                      key={key}
                      className="flex items-center justify-between gap-3 rounded-lg border p-4"
                    >
                      <div>
                        <p className="font-medium">
                          {t(`onboarding.card${capitalize(key)}Title`)}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {t(`onboarding.card${capitalize(key)}Desc`)}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Badge
                          variant={badge === "done" ? "success" : badge === "skipped" ? "muted" : "default"}
                        >
                          {t(`onboarding.hubStatus${capitalize(badge)}`)}
                        </Badge>
                        {key === "tables" ? (
                          <>
                            <Button size="sm" onClick={() => void goToTables()}>
                              {t("onboarding.hubDo")}
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => void markStep("tables", "skipped")}>
                              {t("onboarding.hubSkip")}
                            </Button>
                          </>
                        ) : (
                          <Button size="sm" onClick={() => setView(key)}>
                            {t("onboarding.hubDo")}
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
              <Button size="lg" className="w-full" onClick={complete} disabled={busy}>
                {busy ? <Spinner className="border-primary-foreground" /> : t("onboarding.hubEnterDashboard")}
              </Button>
            </CardContent>
          </Card>
        )}

        {view !== "welcome" &&
          view !== "language" &&
          view !== "mandatory" &&
          view !== "branch" &&
          view !== "hub" &&
          renderInlineStep(view)}
      </div>
    </div>
  );

  async function goToTables() {
    await markStep("tables", "done");
    navigate("/tables");
  }

  function renderInlineStep(step: HubStep) {
    const StepComponent = INLINE_STEPS[step];
    if (!StepComponent) return null;
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t(`onboarding.card${capitalize(step)}Title`)}</CardTitle>
          <div>
            <Button variant="ghost" size="sm" onClick={() => setView("hub")}>
              {t("onboarding.hubBackToHub")}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <StepComponent
            onDone={() => markStep(step, "done")}
            onSkip={() => markStep(step, "skipped")}
          />
        </CardContent>
      </Card>
    );
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
