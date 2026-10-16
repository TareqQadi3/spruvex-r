import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge, Card, CardContent, CardHeader, CardTitle, Input, Spinner } from "@spruvex-r/ui";

import { localizedName } from "../../lib/catalog-api";
import { type BranchComparisonRow, reportsApi } from "../../lib/inventory-api";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

type SortKey = "branchName" | "orderCount" | "totalSales" | "avgOrderValue" | "loyalty" | "ratings";

export function BranchComparisonPage() {
  const { t, i18n } = useTranslation();
  const [from, setFrom] = useState(daysAgoIso(30));
  const [to, setTo] = useState(todayIso());
  const [sortKey, setSortKey] = useState<SortKey>("totalSales");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const result = useQuery({
    queryKey: ["reports", "branch-comparison", from, to],
    queryFn: () => reportsApi.branchComparison(from, to),
  });

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  const sortedRows = useMemo(() => {
    const rows = result.data?.rows ?? [];
    const sorted = [...rows].sort((a, b) => {
      const valueOf = (r: BranchComparisonRow): number | string => {
        switch (sortKey) {
          case "branchName":
            return r.branchName;
          case "orderCount":
            return r.orderCount;
          case "totalSales":
            return Number(r.totalSales);
          case "avgOrderValue":
            return Number(r.avgOrderValue);
          case "loyalty":
            return r.loyalty.usagePercent ?? -1;
          case "ratings":
            return r.ratings.avgRating ?? -1;
        }
      };
      const av = valueOf(a);
      const bv = valueOf(b);
      const cmp = typeof av === "string" ? av.localeCompare(bv as string) : (av as number) - (bv as number);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [result.data, sortKey, sortDir]);

  const maxSales = Math.max(1, ...(result.data?.rows.map((r) => Number(r.totalSales)) ?? [0]));

  function SortHeader({ label, sortKeyName }: { label: string; sortKeyName: SortKey }) {
    return (
      <th
        className="cursor-pointer select-none p-3 text-start hover:text-foreground"
        onClick={() => toggleSort(sortKeyName)}
      >
        {label} {sortKey === sortKeyName ? (sortDir === "desc" ? "▼" : "▲") : ""}
      </th>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>

      {result.isLoading && <Spinner />}

      {result.data && result.data.rows.length === 0 && (
        <p className="text-muted-foreground">{t("reports.branchComparison.empty")}</p>
      )}

      {result.data && result.data.rows.length > 0 && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("reports.branchComparison.chart.title")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {sortedRows.map((row) => (
                <div key={row.branchId} className="flex items-center gap-3 text-sm">
                  <span className="w-40 shrink-0 truncate">
                    {localizedName({ name: row.branchName, nameEn: row.branchNameEn }, i18n.language)}
                  </span>
                  <div className="h-4 flex-1 rounded bg-muted">
                    <div
                      className="h-4 rounded bg-primary"
                      style={{ width: `${(Number(row.totalSales) / maxSales) * 100}%` }}
                    />
                  </div>
                  <span className="w-24 shrink-0 text-end font-medium" dir="ltr">
                    {row.totalSales} SAR
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("reports.branchComparison.table.title")}</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full min-w-[900px] text-sm">
                <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    <SortHeader label={t("reports.branchComparison.table.branch")} sortKeyName="branchName" />
                    <SortHeader label={t("reports.branchComparison.table.orderCount")} sortKeyName="orderCount" />
                    <SortHeader label={t("reports.branchComparison.table.totalSales")} sortKeyName="totalSales" />
                    <SortHeader label={t("reports.branchComparison.table.avgOrderValue")} sortKeyName="avgOrderValue" />
                    <th className="p-3 text-start">{t("reports.branchComparison.table.topProducts")}</th>
                    {result.data.loyaltyAvailable && (
                      <SortHeader label={t("reports.branchComparison.table.loyaltyUsage")} sortKeyName="loyalty" />
                    )}
                    {result.data.ratingsAvailable && (
                      <SortHeader label={t("reports.branchComparison.table.avgRating")} sortKeyName="ratings" />
                    )}
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((row) => (
                    <tr key={row.branchId} className="border-b last:border-0 align-top">
                      <td className="p-3 font-medium">
                        {localizedName({ name: row.branchName, nameEn: row.branchNameEn }, i18n.language)}
                      </td>
                      <td className="p-3">{row.orderCount}</td>
                      <td className="p-3" dir="ltr">{row.totalSales} SAR</td>
                      <td className="p-3" dir="ltr">{row.avgOrderValue} SAR</td>
                      <td className="p-3">
                        <div className="flex flex-wrap gap-1">
                          {row.topProducts.map((p) => (
                            <Badge key={p.productId} variant="muted">
                              {localizedName(p, i18n.language)} × {p.quantitySold}
                            </Badge>
                          ))}
                          {row.topProducts.length === 0 && <span className="text-muted-foreground">—</span>}
                        </div>
                      </td>
                      {result.data.loyaltyAvailable && (
                        <td className="p-3">
                          {row.loyalty.enabled ? (
                            <span dir="ltr">
                              {row.loyalty.usagePercent}% ({row.loyalty.ordersWithLoyalty})
                            </span>
                          ) : (
                            <span className="text-muted-foreground">{t("reports.branchComparison.table.loyaltyDisabled")}</span>
                          )}
                        </td>
                      )}
                      {result.data.ratingsAvailable && (
                        <td className="p-3">
                          {row.ratings.count > 0 ? (
                            <span dir="ltr">{row.ratings.avgRating} ★ ({row.ratings.count})</span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
