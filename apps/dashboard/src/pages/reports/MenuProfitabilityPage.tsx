import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Badge, Button, Card, CardContent, Input, Select, Spinner } from "@spruvex-r/ui";

import { api, ApiError, downloadFile } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { localizedName } from "../../lib/catalog-api";
import { reportsApi } from "../../lib/inventory-api";

interface BranchRow {
  id: string;
  name: string;
  nameEn: string | null;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function MenuProfitabilityPage() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const canExport = Boolean(user?.permissions.includes("reports.export"));

  const branches = useQuery({ queryKey: ["branches"], queryFn: () => api<BranchRow[]>("/branches") });
  const [branchId, setBranchId] = useState("");
  const [from, setFrom] = useState(() => isoDate(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)));
  const [to, setTo] = useState(() => isoDate(new Date()));

  const result = useQuery({
    queryKey: ["reports", "menu-profitability", branchId, from, to],
    queryFn: () => reportsApi.menuProfitability(branchId || undefined, from, to),
  });

  const [downloading, setDownloading] = useState(false);

  async function handleDownload() {
    setDownloading(true);
    try {
      const path = reportsApi.menuProfitabilityDownloadPath(branchId || undefined, from, to);
      await downloadFile(path, `menu-profitability-${from}-to-${to}.csv`);
    } catch (e) {
      alert(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setDownloading(false);
    }
  }

  const data = result.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select className="w-48" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            <option value="">{t("reports.menuProfitability.allBranches")}</option>
            {branches.data?.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {localizedName({ name: branch.name, nameEn: branch.nameEn }, i18n.language)}
              </option>
            ))}
          </Select>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        {canExport && (
          <Button variant="outline" disabled={downloading} onClick={handleDownload}>
            {downloading ? <Spinner className="h-4 w-4" /> : t("reports.menuProfitability.downloadCsv")}
          </Button>
        )}
      </div>

      {!branchId && (
        <Alert>{t("reports.menuProfitability.noBranchNote")}</Alert>
      )}

      {result.isLoading && <Spinner />}

      {data && (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="p-3 text-start">{t("reports.menuProfitability.product")}</th>
                  <th className="p-3 text-start">{t("reports.menuProfitability.cost")}</th>
                  <th className="p-3 text-start">{t("reports.menuProfitability.sellingPrice")}</th>
                  <th className="p-3 text-start">{t("reports.menuProfitability.grossMargin")}</th>
                  <th className="p-3 text-start">{t("reports.menuProfitability.grossMarginPercent")}</th>
                  <th className="p-3 text-start">{t("reports.menuProfitability.quantitySold")}</th>
                  <th className="p-3 text-start">{t("reports.menuProfitability.totalContributionMargin")}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => {
                  const isLossOrBreakeven = Number(row.grossMargin) <= 0;
                  return (
                    <tr
                      key={row.productId}
                      className={`border-b last:border-0 ${isLossOrBreakeven ? "bg-destructive/5" : ""}`}
                    >
                      <td className="p-3">
                        {localizedName({ name: row.productName, nameEn: row.productNameEn }, i18n.language)}
                        {!row.hasRecipe && (
                          <Badge variant="muted" className="ms-2">
                            {t("reports.menuProfitability.noRecipe")}
                          </Badge>
                        )}
                        {isLossOrBreakeven && (
                          <Badge variant="destructive" className="ms-2">
                            {t("reports.menuProfitability.lossAlert")}
                          </Badge>
                        )}
                      </td>
                      <td className="p-3" dir="ltr">
                        {row.cost} SAR
                      </td>
                      <td className="p-3" dir="ltr">
                        {row.sellingPrice} SAR
                      </td>
                      <td className={`p-3 font-medium ${isLossOrBreakeven ? "text-destructive" : ""}`} dir="ltr">
                        {row.grossMargin} SAR
                      </td>
                      <td className={`p-3 ${isLossOrBreakeven ? "text-destructive" : ""}`} dir="ltr">
                        {row.grossMarginPercent}%
                      </td>
                      <td className="p-3" dir="ltr">
                        {row.quantitySold}
                      </td>
                      <td className={`p-3 font-medium ${isLossOrBreakeven ? "text-destructive" : "text-primary"}`} dir="ltr">
                        {row.totalContributionMargin} SAR
                      </td>
                    </tr>
                  );
                })}
                {data.rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="p-4 text-center text-muted-foreground">
                      {t("reports.menuProfitability.empty")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
