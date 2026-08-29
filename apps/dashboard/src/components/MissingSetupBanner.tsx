import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { Alert, Card, CardContent, CardHeader, CardTitle } from "@spruvex-r/ui";

import { api } from "../lib/api";
import { useAuth } from "../lib/auth";

type HubStep = "logo" | "receipt" | "theme" | "zatca" | "staff" | "menu" | "tables";

interface SetupStatusItem {
  step: HubStep;
  done: boolean;
  skipped: boolean;
}

/** Where each deferred onboarding step is finished — the wizard's inline mini-form, or a real page. */
const STEP_LINK: Record<HubStep, string> = {
  logo: "/onboarding?step=logo",
  receipt: "/onboarding?step=receipt",
  theme: "/onboarding?step=theme",
  zatca: "/onboarding?step=zatca",
  staff: "/onboarding?step=staff",
  menu: "/onboarding?step=menu",
  tables: "/tables",
};

/** Dashboard-wide reminder for onboarding steps the owner skipped or hasn't visited yet. */
export function MissingSetupBanner() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const canSeeSetup = Boolean(user?.permissions.includes("tenant.settings.manage"));

  const { data } = useQuery({
    queryKey: ["onboarding-setup-status"],
    queryFn: () => api<SetupStatusItem[]>("/onboarding/setup-status"),
    enabled: canSeeSetup,
    staleTime: 60_000,
  });

  const missing = (data ?? []).filter((item) => !item.done);
  if (!canSeeSetup || missing.length === 0) return null;

  return (
    <Card className="border-dashed">
      <CardHeader>
        <CardTitle className="text-sm">{t("home.missingSetupTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <Alert>{t("home.missingSetupHint")}</Alert>
        <ul className="space-y-1">
          {missing.map((item) => (
            <li key={item.step}>
              <Link
                to={STEP_LINK[item.step]}
                className="text-sm font-medium text-primary underline underline-offset-2"
              >
                {t(`onboarding.card${item.step.charAt(0).toUpperCase()}${item.step.slice(1)}Title`)}
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
