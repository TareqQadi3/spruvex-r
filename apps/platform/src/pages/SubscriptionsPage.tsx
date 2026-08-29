import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { Badge, Card, CardContent, Select } from "@spruvex-r/ui";
// Namespace import: `@spruvex-r/types` builds to CJS, and this app's bundler
// (Vite/Rollup) cannot statically resolve a named runtime export re-exported
// through the package's barrel file — importing the whole namespace sidesteps
// that CJS-interop limitation.
import * as SpruvexTypes from "@spruvex-r/types";
const { PLAN_CATALOG } = SpruvexTypes;

import { ApiError } from "../lib/api";
import {
  platformApi,
  type SubscriptionListItem,
  type SubscriptionStatus,
} from "../lib/platform-api";

const STATUSES: SubscriptionStatus[] = ["trialing", "active", "past_due", "suspended", "cancelled"];

function localizedName(item: { name: string; nameEn?: string | null }, language: string): string {
  return language === "en" && item.nameEn ? item.nameEn : item.name;
}

export function SubscriptionsPage() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["subscriptions"],
    queryFn: platformApi.listSubscriptions,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["subscriptions"] });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: SubscriptionStatus }) =>
      platformApi.setSubscriptionStatus(id, status),
    onSuccess: invalidate,
    onError: (e) => alert(e instanceof ApiError ? e.message : t("common.error")),
  });
  const setPlan = useMutation({
    mutationFn: ({ id, planKey }: { id: string; planKey: string }) =>
      platformApi.changeSubscriptionPlan(id, planKey),
    onSuccess: invalidate,
    onError: (e) => alert(e instanceof ApiError ? e.message : t("common.error")),
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">{t("subscriptions.title")}</h1>
      <Card>
        <CardContent className="p-0">
          {isLoading && <div className="p-4">…</div>}
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="p-3 text-start">{t("subscriptions.tenant")}</th>
                <th className="p-3 text-start">{t("subscriptions.plan")}</th>
                <th className="p-3 text-start">{t("subscriptions.status")}</th>
                <th className="p-3 text-start">{t("subscriptions.trialEndsAt")}</th>
              </tr>
            </thead>
            <tbody>
              {data?.map((sub: SubscriptionListItem) => (
                <tr key={sub.id} className="border-b last:border-0">
                  <td className="p-3">
                    <div className="flex items-center gap-2">
                      {localizedName(sub.tenant, i18n.language)}
                      {sub.tenant.status === "suspended" && (
                        <Badge variant="destructive">{t("tenants.suspended")}</Badge>
                      )}
                    </div>
                  </td>
                  <td className="p-3">
                    <Select
                      className="w-32"
                      value={sub.plan.key}
                      disabled={setPlan.isPending}
                      onChange={(e) => setPlan.mutate({ id: sub.id, planKey: e.target.value })}
                    >
                      {PLAN_CATALOG.map((plan) => (
                        <option key={plan.key} value={plan.key}>
                          {localizedName(plan, i18n.language)}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="p-3">
                    <Select
                      className="w-36"
                      value={sub.status}
                      disabled={setStatus.isPending}
                      onChange={(e) =>
                        setStatus.mutate({ id: sub.id, status: e.target.value as SubscriptionStatus })
                      }
                    >
                      {STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {t(`subscriptions.statuses.${s}`)}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="p-3 text-muted-foreground" dir="ltr">
                    {sub.trialEndsAt ? new Date(sub.trialEndsAt).toLocaleDateString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
