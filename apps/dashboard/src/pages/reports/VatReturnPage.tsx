import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Select, Spinner } from "@spruvex-r/ui";

import { api, ApiError, downloadFile } from "../../lib/api";
import { useAuth } from "../../lib/auth";
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

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Plain digits-only date, e.g. "2026-08-30" — avoids locale-dependent
 * separators mixing with bidi marks (Arabic renders "30‏/8‏/2026" with
 * embedded RTL marks that garble under a forced ltr direction). */
function formatDocumentDate(iso: string): string {
  return isoDate(new Date(iso));
}

/** Quick VAT-cycle presets matching how ZATCA return periods are usually filed. */
function usePeriodPresets() {
  const now = new Date();
  const startOfThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const startOfLastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const endOfLastMonth = new Date(startOfThisMonth.getTime() - 1);
  const currentQuarter = Math.floor(now.getUTCMonth() / 3);
  const startOfThisQuarter = new Date(Date.UTC(now.getUTCFullYear(), currentQuarter * 3, 1));

  return {
    thisMonth: { from: isoDate(startOfThisMonth), to: todayIso() },
    lastMonth: { from: isoDate(startOfLastMonth), to: isoDate(endOfLastMonth) },
    thisQuarter: { from: isoDate(startOfThisQuarter), to: todayIso() },
  };
}

export function VatReturnPage() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const canExport = Boolean(user?.permissions.includes("reports.export"));
  const presets = usePeriodPresets();

  const branches = useQuery({ queryKey: ["branches"], queryFn: () => api<BranchRow[]>("/branches") });
  const [branchId, setBranchId] = useState("");
  const [from, setFrom] = useState(presets.thisMonth.from);
  const [to, setTo] = useState(presets.thisMonth.to);

  const result = useQuery({
    queryKey: ["reports", "vat-return", branchId, from, to],
    queryFn: () => reportsApi.vatReturn(branchId || undefined, from, to),
  });

  const [downloading, setDownloading] = useState<"csv" | "pdf" | null>(null);

  async function handleDownload(format: "csv" | "pdf") {
    setDownloading(format);
    try {
      const path = reportsApi.vatReturnDownloadPath(format, branchId || undefined, from, to);
      await downloadFile(path, `vat-return-${from}-to-${to}.${format}`);
    } catch (e) {
      alert(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setDownloading(null);
    }
  }

  const data = result.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select className="w-48" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            <option value="">{t("reports.vatReturn.allBranches")}</option>
            {branches.data?.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {localizedName({ name: branch.name, nameEn: branch.nameEn }, i18n.language)}
              </option>
            ))}
          </Select>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          <Button variant="outline" size="sm" onClick={() => { setFrom(presets.thisMonth.from); setTo(presets.thisMonth.to); }}>
            {t("reports.vatReturn.presets.thisMonth")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => { setFrom(presets.lastMonth.from); setTo(presets.lastMonth.to); }}>
            {t("reports.vatReturn.presets.lastMonth")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => { setFrom(presets.thisQuarter.from); setTo(presets.thisQuarter.to); }}>
            {t("reports.vatReturn.presets.thisQuarter")}
          </Button>
        </div>
        {canExport && (
          <div className="flex items-center gap-2">
            <Button variant="outline" disabled={downloading !== null} onClick={() => handleDownload("csv")}>
              {downloading === "csv" ? <Spinner className="h-4 w-4" /> : t("reports.vatReturn.downloadCsv")}
            </Button>
            <Button variant="outline" disabled={downloading !== null} onClick={() => handleDownload("pdf")}>
              {downloading === "pdf" ? <Spinner className="h-4 w-4" /> : t("reports.vatReturn.downloadPdf")}
            </Button>
          </div>
        )}
      </div>

      {result.isLoading && <Spinner />}

      {data && (
        <>
          <Card>
            <CardContent className="grid grid-cols-1 gap-4 pt-6 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <p className="text-muted-foreground">{t("reports.vatReturn.entity")}</p>
                <p className="font-medium">{data.tenant.legalName ?? data.tenant.name}</p>
              </div>
              <div>
                <p className="text-muted-foreground">{t("reports.vatReturn.vatNumber")}</p>
                <p className="font-medium" dir="ltr">{data.tenant.vatNumber ?? "—"}</p>
              </div>
              <div>
                <p className="text-muted-foreground">{t("reports.vatReturn.scope")}</p>
                <p className="font-medium">
                  {data.branch
                    ? localizedName({ name: data.branch.name, nameEn: data.branch.nameEn }, i18n.language)
                    : t("reports.vatReturn.allBranchesConsolidated")}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">{t("reports.vatReturn.period")}</p>
                <p className="font-medium" dir="ltr">{data.period.from} → {data.period.to}</p>
              </div>
            </CardContent>
          </Card>

          <Alert>
            <p className="font-medium">{t("reports.vatReturn.inputTax.title")}</p>
            <p className="mt-1 text-sm">{data.inputTax.note}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("reports.vatReturn.inputTax.recordedPurchaseCost")}: {data.inputTax.recordedPurchaseCost} SAR
            </p>
          </Alert>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm text-muted-foreground">{t("reports.vatReturn.netTaxableSales")}</CardTitle>
              </CardHeader>
              <CardContent className="text-2xl font-bold text-primary" dir="ltr">
                {data.totals.netTaxableSales} SAR
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm text-muted-foreground">{t("reports.vatReturn.outputVat")}</CardTitle>
              </CardHeader>
              <CardContent className="text-2xl font-bold text-primary" dir="ltr">
                {data.totals.outputVat} SAR
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm text-muted-foreground">{t("reports.vatReturn.netVatDue")}</CardTitle>
              </CardHeader>
              <CardContent className="text-2xl font-bold text-primary" dir="ltr">
                {data.netVatDue} SAR
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("reports.vatReturn.byRate.title")}</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full min-w-[900px] text-sm">
                <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    <th className="p-3 text-start">{t("reports.vatReturn.byRate.rate")}</th>
                    <th className="p-3 text-start">{t("reports.vatReturn.byRate.salesNet")}</th>
                    <th className="p-3 text-start">{t("reports.vatReturn.byRate.salesVat")}</th>
                    <th className="p-3 text-start">{t("reports.vatReturn.byRate.creditNoteNet")}</th>
                    <th className="p-3 text-start">{t("reports.vatReturn.byRate.debitNoteNet")}</th>
                    <th className="p-3 text-start">{t("reports.vatReturn.byRate.netTaxableSales")}</th>
                    <th className="p-3 text-start">{t("reports.vatReturn.byRate.netVat")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byRate.map((b) => (
                    <tr key={b.vatRatePercent} className="border-b last:border-0">
                      <td className="p-3" dir="ltr">{b.vatRatePercent}%</td>
                      <td className="p-3" dir="ltr">{b.salesNet} SAR</td>
                      <td className="p-3" dir="ltr">{b.salesVat} SAR</td>
                      <td className="p-3" dir="ltr">-{b.creditNoteNet} SAR</td>
                      <td className="p-3" dir="ltr">+{b.debitNoteNet} SAR</td>
                      <td className="p-3 font-medium" dir="ltr">{b.netTaxableSales} SAR</td>
                      <td className="p-3 font-medium" dir="ltr">{b.netVat} SAR</td>
                    </tr>
                  ))}
                  {data.byRate.length === 0 && (
                    <tr>
                      <td colSpan={7} className="p-4 text-center text-muted-foreground">
                        {t("reports.vatReturn.empty")}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("reports.vatReturn.lineItems.title")}</CardTitle>
            </CardHeader>
            <CardContent className="max-h-[480px] overflow-auto p-0">
              <table className="w-full min-w-[900px] text-sm">
                <thead className="sticky top-0 border-b bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    <th className="p-3 text-start">{t("reports.vatReturn.lineItems.type")}</th>
                    <th className="p-3 text-start">{t("reports.vatReturn.lineItems.branch")}</th>
                    <th className="p-3 text-start">{t("reports.vatReturn.lineItems.documentNumber")}</th>
                    <th className="p-3 text-start">{t("reports.vatReturn.lineItems.reference")}</th>
                    <th className="p-3 text-start">{t("reports.vatReturn.lineItems.date")}</th>
                    <th className="p-3 text-start">{t("reports.vatReturn.lineItems.net")}</th>
                    <th className="p-3 text-start">{t("reports.vatReturn.lineItems.vat")}</th>
                    <th className="p-3 text-start">{t("reports.vatReturn.lineItems.total")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.lineItems.map((li, idx) => (
                    <tr key={`${li.type}-${li.documentNumber}-${li.branchName}-${idx}`} className="border-b last:border-0">
                      <td className="p-3">
                        <Badge variant={li.type === "sale" ? "muted" : li.type === "credit_note" ? "destructive" : "default"}>
                          {t(`reports.vatReturn.lineItems.types.${li.type}`)}
                        </Badge>
                      </td>
                      <td className="p-3">{localizedName({ name: li.branchName, nameEn: li.branchNameEn }, i18n.language)}</td>
                      <td className="p-3" dir="ltr">#{li.documentNumber}</td>
                      <td className="p-3" dir="ltr">{li.referenceReceiptNumber ? `#${li.referenceReceiptNumber}` : "—"}</td>
                      <td className="p-3" dir="ltr">{formatDocumentDate(li.issuedAt)}</td>
                      <td className="p-3" dir="ltr">{li.netAmount} SAR</td>
                      <td className="p-3" dir="ltr">{li.vatAmount} SAR</td>
                      <td className="p-3 font-medium" dir="ltr">{li.total} SAR</td>
                    </tr>
                  ))}
                  {data.lineItems.length === 0 && (
                    <tr>
                      <td colSpan={8} className="p-4 text-center text-muted-foreground">
                        {t("reports.vatReturn.empty")}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
