import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge, Card, CardContent, CardHeader, CardTitle, Input, Label, Select, Spinner } from "@spruvex-r/ui";

import { api } from "../../lib/api";
import { localizedName } from "../../lib/catalog-api";
import { reportsApi } from "../../lib/inventory-api";

interface BranchRow {
  id: string;
  name: string;
  nameEn: string | null;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function ReportsPage() {
  const { t, i18n } = useTranslation();

  const branches = useQuery({ queryKey: ["branches"], queryFn: () => api<BranchRow[]>("/branches") });
  const [branchId, setBranchId] = useState("");
  const activeBranchId = branchId || branches.data?.[0]?.id || "";

  const [from, setFrom] = useState(daysAgoIso(30));
  const [to, setTo] = useState(todayIso());

  const daily = useQuery({
    queryKey: ["reports", "daily", activeBranchId],
    queryFn: () => reportsApi.dailySales(activeBranchId),
    enabled: Boolean(activeBranchId),
  });
  const bestSellers = useQuery({
    queryKey: ["reports", "best-sellers", activeBranchId, from, to],
    queryFn: () => reportsApi.bestSellers(activeBranchId, from, to, 10),
    enabled: Boolean(activeBranchId),
  });
  const operations = useQuery({
    queryKey: ["reports", "operations", activeBranchId, from, to],
    queryFn: () => reportsApi.operations(activeBranchId, from, to),
    enabled: Boolean(activeBranchId),
  });
  const financial = useQuery({
    queryKey: ["reports", "financial", activeBranchId, from, to],
    queryFn: () => reportsApi.financial(activeBranchId, from, to),
    enabled: Boolean(activeBranchId),
  });
  const ratings = useQuery({
    queryKey: ["reports", "ratings", activeBranchId, from, to],
    queryFn: () => reportsApi.ratings(activeBranchId, from, to),
    enabled: Boolean(activeBranchId),
  });

  const isLoading = daily.isLoading || bestSellers.isLoading || operations.isLoading || financial.isLoading;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-end gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select className="w-48" value={activeBranchId} onChange={(e) => setBranchId(e.target.value)}>
            {branches.data?.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {localizedName({ name: branch.name, nameEn: branch.nameEn }, i18n.language)}
              </option>
            ))}
          </Select>
          <Label htmlFor="rfrom" className="sr-only">
            {t("reports.from")}
          </Label>
          <Input id="rfrom" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <Input id="rto" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>

      {isLoading && <Spinner />}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">{t("reports.todayOrders")}</CardTitle>
          </CardHeader>
          <CardContent className="text-3xl font-bold text-primary">{daily.data?.orderCount ?? "—"}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">{t("reports.todaySales")}</CardTitle>
          </CardHeader>
          <CardContent className="text-3xl font-bold text-primary" dir="ltr">
            {daily.data?.total ?? "—"} SAR
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">{t("reports.avgOrderValue")}</CardTitle>
          </CardHeader>
          <CardContent className="text-3xl font-bold text-primary" dir="ltr">
            {daily.data?.avgOrderValue ?? "—"} SAR
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">{t("reports.avgPrepTime")}</CardTitle>
          </CardHeader>
          <CardContent className="text-3xl font-bold text-primary" dir="ltr">
            {operations.data?.avgPrepTimeMinutes ?? "—"} {t("reports.minutes")}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">{t("reports.ratings.avg")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-primary" dir="ltr">
              {ratings.data?.avgRating != null ? `${ratings.data.avgRating} ★` : "—"}
            </div>
            {ratings.data && (
              <p className="text-xs text-muted-foreground">{t("reports.ratings.count", { count: ratings.data.count })}</p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("reports.financial.title")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {financial.data && (
              <>
                <Row label={t("reports.financial.revenue")} value={`${financial.data.revenue} SAR`} />
                <Row label={t("reports.financial.discounts")} value={`${financial.data.discounts} SAR`} />
                <Row label={t("reports.financial.vat")} value={`${financial.data.vatCollected} SAR`} />
                <Row
                  label={t("reports.financial.foodCost")}
                  value={`${financial.data.foodCost} SAR (${financial.data.foodCostPercent}%)`}
                />
                <Row
                  label={t("reports.financial.grossMargin")}
                  value={`${financial.data.grossMargin} SAR (${financial.data.grossMarginPercent}%)`}
                />
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("reports.operations.title")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {operations.data && (
              <>
                <Row label={t("reports.operations.completed")} value={String(operations.data.orderCount)} />
                <Row label={t("reports.operations.cancelled")} value={String(operations.data.cancelledCount)} />
                <Row label={t("reports.operations.avgOrderValue")} value={`${operations.data.avgOrderValue} SAR`} />
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("reports.bestSellers.title")}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="p-3 text-start">{t("reports.bestSellers.product")}</th>
                <th className="p-3 text-start">{t("reports.bestSellers.quantity")}</th>
                <th className="p-3 text-start">{t("reports.bestSellers.revenue")}</th>
              </tr>
            </thead>
            <tbody>
              {bestSellers.data?.map((entry) => (
                <tr key={entry.productId} className="border-b last:border-0">
                  <td className="p-3">{localizedName(entry, i18n.language)}</td>
                  <td className="p-3">{entry.quantitySold}</td>
                  <td className="p-3" dir="ltr">
                    {entry.revenue} SAR
                  </td>
                </tr>
              ))}
              {bestSellers.data?.length === 0 && (
                <tr>
                  <td colSpan={3} className="p-4 text-center text-muted-foreground">
                    {t("reports.bestSellers.empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("reports.ratings.lowRatings.title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {ratings.data && ratings.data.byBranch.length > 1 && (
            <div className="flex flex-wrap gap-2 border-b pb-3">
              {ratings.data.byBranch.map((branch) => (
                <Badge key={branch.branchId} variant="muted">
                  {localizedName({ name: branch.name, nameEn: branch.nameEn }, i18n.language)}: {branch.avgRating} ★ (
                  {branch.count})
                </Badge>
              ))}
            </div>
          )}
          {ratings.data?.lowRatings.length === 0 && (
            <p className="text-center text-sm text-muted-foreground">{t("reports.ratings.lowRatings.empty")}</p>
          )}
          {ratings.data?.lowRatings.map((row) => (
            <div key={row.id} className="rounded-md border p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-medium" dir="ltr">
                  {t("reports.ratings.lowRatings.order", { number: row.orderNumber })}
                </span>
                <Badge variant="destructive">{row.rating} ★</Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {localizedName({ name: row.branchName, nameEn: row.branchNameEn }, i18n.language)}
                {row.productName ? ` — ${localizedName({ name: row.productName, nameEn: row.productNameEn }, i18n.language)}` : ""}
              </p>
              {row.comment && (
                <p className="mt-2 text-sm">
                  <span className="text-muted-foreground">{t("reports.ratings.lowRatings.comment")}: </span>
                  {row.comment}
                </p>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span dir="ltr" className="font-medium">
        {value}
      </span>
    </div>
  );
}
