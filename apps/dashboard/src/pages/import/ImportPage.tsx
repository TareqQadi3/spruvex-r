import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, FileSpreadsheet, Gift, Upload as UploadIcon } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Select, Spinner } from "@spruvex-r/ui";
import type { ImportDataType } from "@spruvex-r/types";

import { ApiError } from "../../lib/api";
import {
  importApi,
  type ImportJobDetail,
  type ImportJobSummary,
  type ImportRowResult,
} from "../../lib/import-api";
import { useAuth } from "../../lib/auth";

type WizardStep = "select-type" | "upload" | "mapping" | "preview" | "result";

const TYPE_ICON: Record<ImportDataType, typeof FileSpreadsheet> = {
  categories: FileSpreadsheet,
  products: FileSpreadsheet,
  customers: Gift,
};

const TYPE_PERMISSION: Record<ImportDataType, string> = {
  categories: "menu.manage",
  products: "menu.manage",
  customers: "loyalty.manage",
};

function statusBadgeVariant(status: string): "success" | "muted" | "destructive" {
  if (status === "created" || status === "would_create") return "success";
  if (status === "skipped_duplicate") return "muted";
  return "destructive";
}

export function ImportPage() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<WizardStep>("select-type");
  const [selectedType, setSelectedType] = useState<ImportDataType | null>(null);
  const [job, setJob] = useState<ImportJobDetail | null>(null);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [previewRows, setPreviewRows] = useState<ImportRowResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportJobSummary | null>(null);

  const history = useQuery({ queryKey: ["imports", "history"], queryFn: importApi.list });

  const permissions = new Set(user?.permissions ?? []);
  const canSee = (type: ImportDataType) => permissions.has(TYPE_PERMISSION[type]);

  function resetToStart() {
    setStep("select-type");
    setSelectedType(null);
    setJob(null);
    setMapping({});
    setPreviewRows(null);
    setResult(null);
    setError(null);
    void queryClient.invalidateQueries({ queryKey: ["imports", "history"] });
  }

  const upload = useMutation({
    mutationFn: (file: File) => importApi.upload(selectedType!, file),
    onSuccess: (data) => {
      setJob(data);
      setMapping(data.mapping ?? {});
      setError(null);
      setStep("mapping");
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t("common.error")),
  });

  const confirmMapping = useMutation({
    mutationFn: async () => {
      const updated = await importApi.setMapping(job!.id, mapping);
      const previewed = await importApi.preview(job!.id);
      return { updated, previewed };
    },
    onSuccess: ({ updated, previewed }) => {
      setJob(updated);
      setPreviewRows(previewed.rows);
      setError(null);
      setStep("preview");
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t("common.error")),
  });

  const execute = useMutation({
    mutationFn: () => importApi.execute(job!.id),
    onSuccess: (data) => {
      setResult(data);
      setError(null);
      setStep("result");
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t("common.error")),
  });

  const typeCards: { type: ImportDataType; titleKey: string; descKey: string }[] = [
    { type: "categories", titleKey: "import.typeCategories", descKey: "import.typeCategoriesDesc" },
    { type: "products", titleKey: "import.typeProducts", descKey: "import.typeProductsDesc" },
    { type: "customers", titleKey: "import.typeCustomers", descKey: "import.typeCustomersDesc" },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("import.title")}</h1>
        <p className="text-muted-foreground">{t("import.subtitle")}</p>
      </div>

      {error && <Alert variant="destructive">{error}</Alert>}

      {step === "select-type" && (
        <>
          <h2 className="text-lg font-semibold">{t("import.chooseType")}</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {typeCards
              .filter((c) => canSee(c.type))
              .map((c) => {
                const Icon = TYPE_ICON[c.type];
                return (
                  <Card
                    key={c.type}
                    className="cursor-pointer transition-shadow hover:shadow-md"
                    onClick={() => {
                      setSelectedType(c.type);
                      setStep("upload");
                    }}
                  >
                    <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
                      <Icon className="h-8 w-8 text-primary" />
                      <div>
                        <div className="font-semibold">{t(c.titleKey)}</div>
                        <div className="text-sm text-muted-foreground">{t(c.descKey)}</div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
          </div>

          <Card>
            <CardHeader>
              <CardTitle>{t("import.history")}</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              {history.isLoading && (
                <div className="flex justify-center p-6">
                  <Spinner />
                </div>
              )}
              {history.data && history.data.length === 0 && (
                <p className="p-6 text-center text-sm text-muted-foreground">{t("import.historyEmpty")}</p>
              )}
              {history.data && history.data.length > 0 && (
                <table className="w-full min-w-[700px] text-sm">
                  <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                    <tr>
                      <th className="p-3 text-start">{t("import.filename")}</th>
                      <th className="p-3 text-start">{t("import.rowCount")}</th>
                      <th className="p-3 text-start">{t("import.createdAt")}</th>
                      <th className="p-3 text-start">{t("common.status")}</th>
                      <th className="p-3 text-start" />
                    </tr>
                  </thead>
                  <tbody>
                    {history.data.map((row) => (
                      <tr key={row.id} className="border-b last:border-0">
                        <td className="p-3">{row.filename}</td>
                        <td className="p-3">{row.rowCount}</td>
                        <td className="p-3">{new Date(row.createdAt).toLocaleString(i18n.language)}</td>
                        <td className="p-3">
                          <Badge variant={row.status === "completed" ? "success" : "muted"}>
                            {t(`import.status${row.status[0].toUpperCase()}${row.status.slice(1)}`)}
                          </Badge>
                          {row.status === "completed" && (
                            <span className="ms-2 text-xs text-muted-foreground">
                              {row.successCount ?? 0} / {row.rowCount}
                            </span>
                          )}
                        </td>
                        <td className="p-3">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={async () => {
                              const full = await importApi.get(row.id);
                              setJob(full);
                              setSelectedType(full.type);
                              setMapping(full.mapping ?? {});
                              if (full.status === "completed") {
                                setResult(full);
                                setStep("result");
                              } else {
                                setStep("mapping");
                              }
                            }}
                          >
                            {t("import.viewResult")}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {step === "upload" && selectedType && (
        <Card className="max-w-xl">
          <CardHeader>
            <CardTitle>{t(typeCards.find((c) => c.type === selectedType)!.titleKey)}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">{t("import.uploadHint")}</p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) upload.mutate(file);
              }}
            />
            <div className="flex items-center gap-2">
              <Button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={upload.isPending}
              >
                {upload.isPending ? (
                  <>
                    <Spinner className="h-4 w-4" /> {t("import.uploading")}
                  </>
                ) : (
                  <>
                    <UploadIcon className="h-4 w-4" /> {t("import.uploadLabel")}
                  </>
                )}
              </Button>
              <Button type="button" variant="ghost" onClick={resetToStart}>
                {t("import.back")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === "mapping" && job && (
        <Card>
          <CardHeader>
            <CardTitle>{t("import.mappingTitle")}</CardTitle>
            <p className="text-sm text-muted-foreground">{t("import.mappingSubtitle")}</p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[600px] text-sm">
                <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    <th className="p-3 text-start">{t("import.sourceColumn")}</th>
                    <th className="p-3 text-start">{t("import.targetField")}</th>
                  </tr>
                </thead>
                <tbody>
                  {job.headers.map((header) => (
                    <tr key={header} className="border-b last:border-0">
                      <td className="p-3 font-medium">{header}</td>
                      <td className="p-3">
                        <Select
                          className="max-w-xs"
                          value={mapping[header] ?? ""}
                          onChange={(e) =>
                            setMapping((prev) => ({ ...prev, [header]: e.target.value || null }))
                          }
                        >
                          <option value="">{t("import.ignoreColumn")}</option>
                          {job.availableFields.map((f) => (
                            <option key={f.key} value={f.key}>
                              {(i18n.language === "ar" ? f.labelAr : f.labelEn) + (f.required ? ` (${t("import.required")})` : "")}
                            </option>
                          ))}
                        </Select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center gap-2">
              <Button onClick={() => confirmMapping.mutate()} disabled={confirmMapping.isPending}>
                {confirmMapping.isPending ? <Spinner className="h-4 w-4" /> : null}
                {t("import.continueToPreview")}
              </Button>
              <Button variant="ghost" onClick={resetToStart}>
                {t("import.back")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === "preview" && job && previewRows && (
        <Card>
          <CardHeader>
            <CardTitle>{t("import.previewTitle")}</CardTitle>
            <p className="text-sm text-muted-foreground">
              {t("import.previewSubtitle", { count: previewRows.length, total: job.rowCount })}
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[600px] text-sm">
                <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    <th className="p-3 text-start">{t("import.previewRow")}</th>
                    <th className="p-3 text-start">{t("common.status")}</th>
                    <th className="p-3 text-start">{t("import.statusError")}</th>
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((row) => (
                    <tr key={row.rowNumber} className="border-b last:border-0">
                      <td className="p-3">{row.rowNumber}</td>
                      <td className="p-3">
                        <Badge variant={statusBadgeVariant(row.status)}>
                          {row.status === "would_create" && t("import.statusWouldCreate")}
                          {row.status === "skipped_duplicate" && t("import.statusDuplicate")}
                          {row.status === "failed" && t("import.statusError")}
                        </Badge>
                        {row.identifier ? <span className="ms-2 text-muted-foreground">{row.identifier}</span> : null}
                      </td>
                      <td className="p-3 text-destructive">{row.error ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center gap-2">
              <Button onClick={() => execute.mutate()} disabled={execute.isPending}>
                {execute.isPending ? (
                  <>
                    <Spinner className="h-4 w-4" /> {t("import.executing")}
                  </>
                ) : (
                  t("import.confirmExecute")
                )}
              </Button>
              <Button variant="outline" onClick={() => setStep("mapping")}>
                {t("import.backToMapping")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === "result" && result && (
        <Card className="max-w-xl">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-primary" />
              {t("import.resultTitle")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <StatTile label={t("import.resultTotal")} value={result.rowCount} />
              <StatTile label={t("import.resultSuccess")} value={result.successCount ?? 0} variant="success" />
              <StatTile label={t("import.resultSkipped")} value={result.skippedCount ?? 0} variant="muted" />
              <StatTile label={t("import.resultFailed")} value={result.failedCount ?? 0} variant="destructive" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {(result.failedCount ?? 0) + (result.skippedCount ?? 0) > 0 && (
                <Button
                  variant="outline"
                  onClick={() => importApi.downloadFailedRows(result.id, `import-${result.type}-issues.csv`)}
                >
                  {t("import.downloadIssues")}
                </Button>
              )}
              <Button onClick={resetToStart}>{t("import.startAnother")}</Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function StatTile({
  label,
  value,
  variant,
}: {
  label: string;
  value: number;
  variant?: "success" | "muted" | "destructive";
}) {
  return (
    <div className="rounded-lg border p-3 text-center">
      <div
        className={
          variant === "success"
            ? "text-2xl font-bold text-primary"
            : variant === "destructive"
              ? "text-2xl font-bold text-destructive"
              : "text-2xl font-bold"
        }
      >
        {value}
      </div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
