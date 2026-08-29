import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { Badge, Card, CardContent, CardHeader, CardTitle } from "@spruvex-r/ui";

import { MissingSetupBanner } from "../../components/MissingSetupBanner";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { localizedName } from "../../lib/catalog-api";
import { reportsApi } from "../../lib/inventory-api";

export function HomePage() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const canBranches = user?.permissions.includes("branches.manage");
  const canUsers = user?.permissions.includes("users.manage");
  const canReports = user?.permissions.includes("reports.view");

  const branches = useQuery({
    queryKey: ["branches"],
    queryFn: () => api<unknown[]>("/branches"),
    enabled: Boolean(canBranches),
  });
  const members = useQuery({
    queryKey: ["users"],
    queryFn: () => api<unknown[]>("/users"),
    enabled: Boolean(canUsers),
  });
  const summary = useQuery({
    queryKey: ["reports", "dashboard-summary"],
    queryFn: () => reportsApi.dashboardSummary(),
    enabled: Boolean(canReports),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("home.welcome", { name: user?.name ?? "" })}</h1>
        <p className="text-muted-foreground">{t("home.subtitle")}</p>
      </div>

      <MissingSetupBanner />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {canBranches && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm text-muted-foreground">
                {t("home.branchesCard")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-primary">
                {branches.data?.length ?? "—"}
              </div>
            </CardContent>
          </Card>
        )}
        {canUsers && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm text-muted-foreground">{t("home.teamCard")}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-primary">{members.data?.length ?? "—"}</div>
            </CardContent>
          </Card>
        )}
      </div>

      {canReports && summary.data && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm text-muted-foreground">{t("home.todayOrders")}</CardTitle>
              </CardHeader>
              <CardContent className="text-3xl font-bold text-primary">
                {summary.data.todaySales.orderCount}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm text-muted-foreground">{t("home.todaySales")}</CardTitle>
              </CardHeader>
              <CardContent className="text-3xl font-bold text-primary" dir="ltr">
                {summary.data.todaySales.total} SAR
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm text-muted-foreground">{t("home.bestSeller")}</CardTitle>
              </CardHeader>
              <CardContent className="text-lg font-semibold text-primary">
                {summary.data.bestSellers[0]
                  ? localizedName(summary.data.bestSellers[0], i18n.language)
                  : "—"}
              </CardContent>
            </Card>
          </div>

          {summary.data.lowStockAlerts.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm text-muted-foreground">{t("home.inventoryAlerts")}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {summary.data.lowStockAlerts.map((alert) => (
                  <Badge key={alert.ingredientId} variant="destructive">
                    {localizedName(alert, i18n.language)} ({alert.quantity})
                  </Badge>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      <Card className="border-dashed">
        <CardContent className="py-6 text-sm text-muted-foreground">
          {t("home.nextUp")}
        </CardContent>
      </Card>
    </div>
  );
}
