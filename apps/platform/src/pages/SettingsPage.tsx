import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Spinner } from "@spruvex-r/ui";

import { ApiError } from "../lib/api";
import { platformApi, type PlatformSettings } from "../lib/platform-api";

/** Mirrors uploads.service.ts's MULTER_HARD_CEILING_BYTES — Multer enforces
 * this synchronously at decoration time, so no configured limit can ever
 * exceed it (the server itself rejects an attempt with a 400). */
const MAX_UPLOAD_MB_CEILING = 20;

const BOUNDS = {
  otpTtlMinutes: { min: 1, max: 60 },
  otpMaxVerifyAttempts: { min: 1, max: 20 },
  maxFailedLogins: { min: 1, max: 20 },
  lockoutMinutes: { min: 1, max: 1440 },
  maxUploadMb: { min: 1, max: MAX_UPLOAD_MB_CEILING },
} as const;

type FormState = Record<keyof typeof BOUNDS, string>;

function bytesToMb(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

function formatChangeValue(key: string, value: unknown): string {
  if (key === "maxUploadBytes" && typeof value === "number") {
    return `${bytesToMb(value)}MB`;
  }
  return String(value);
}

export function SettingsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["platform-settings"],
    queryFn: platformApi.getSettings,
  });
  const { data: auditLog, isLoading: auditLoading } = useQuery({
    queryKey: ["platform-settings-audit-log"],
    queryFn: platformApi.settingsAuditLog,
  });

  const [form, setForm] = useState<FormState>({
    otpTtlMinutes: "",
    otpMaxVerifyAttempts: "",
    maxFailedLogins: "",
    lockoutMinutes: "",
    maxUploadMb: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) {
      setForm({
        otpTtlMinutes: String(data.otpTtlMinutes),
        otpMaxVerifyAttempts: String(data.otpMaxVerifyAttempts),
        maxFailedLogins: String(data.maxFailedLogins),
        lockoutMinutes: String(data.lockoutMinutes),
        maxUploadMb: String(bytesToMb(data.maxUploadBytes)),
      });
    }
  }, [data]);

  const queryClientInvalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["platform-settings"] }),
      queryClient.invalidateQueries({ queryKey: ["platform-settings-audit-log"] }),
    ]);

  const save = useMutation({
    mutationFn: (body: Partial<PlatformSettings>) => platformApi.updateSettings(body),
    onSuccess: async () => {
      await queryClientInvalidate();
      setSaved(true);
      setError(null);
      setTimeout(() => setSaved(false), 3000);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t("common.error")),
  });

  function submit(event: FormEvent) {
    event.preventDefault();

    // Client-side pre-check for fast feedback only — the server enforces the
    // exact same bounds and is still the authority; onError below surfaces
    // whatever it actually rejects, this never assumes the check is enough.
    const parsed: Record<string, number> = {};
    for (const key of Object.keys(BOUNDS) as (keyof typeof BOUNDS)[]) {
      const value = Number(form[key]);
      const { min, max } = BOUNDS[key];
      if (!Number.isInteger(value) || value < min || value > max) {
        setError(t("settings.rangeError", { field: t(`settings.${key}`), min, max }));
        return;
      }
      parsed[key] = value;
    }

    save.mutate({
      otpTtlMinutes: parsed.otpTtlMinutes,
      otpMaxVerifyAttempts: parsed.otpMaxVerifyAttempts,
      maxFailedLogins: parsed.maxFailedLogins,
      lockoutMinutes: parsed.lockoutMinutes,
      maxUploadBytes: parsed.maxUploadMb * 1024 * 1024,
    });
  }

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold">{t("settings.title")}</h1>

      <Card>
        <CardHeader>
          <CardTitle>{t("settings.policyTitle")}</CardTitle>
          <CardDescription>{t("settings.policyHint")}</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading && <Spinner />}
          {data && (
            <form onSubmit={submit} className="space-y-4">
              {error && <Alert variant="destructive">{error}</Alert>}
              {saved && <Alert>{t("settings.saved")}</Alert>}

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="otpTtlMinutes">{t("settings.otpTtlMinutes")}</Label>
                  <Input
                    id="otpTtlMinutes"
                    dir="ltr"
                    type="number"
                    min={BOUNDS.otpTtlMinutes.min}
                    max={BOUNDS.otpTtlMinutes.max}
                    value={form.otpTtlMinutes}
                    onChange={(e) => setForm({ ...form, otpTtlMinutes: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="otpMaxVerifyAttempts">{t("settings.otpMaxVerifyAttempts")}</Label>
                  <Input
                    id="otpMaxVerifyAttempts"
                    dir="ltr"
                    type="number"
                    min={BOUNDS.otpMaxVerifyAttempts.min}
                    max={BOUNDS.otpMaxVerifyAttempts.max}
                    value={form.otpMaxVerifyAttempts}
                    onChange={(e) => setForm({ ...form, otpMaxVerifyAttempts: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="maxFailedLogins">{t("settings.maxFailedLogins")}</Label>
                  <Input
                    id="maxFailedLogins"
                    dir="ltr"
                    type="number"
                    min={BOUNDS.maxFailedLogins.min}
                    max={BOUNDS.maxFailedLogins.max}
                    value={form.maxFailedLogins}
                    onChange={(e) => setForm({ ...form, maxFailedLogins: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">{t("settings.maxFailedLoginsHint")}</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lockoutMinutes">{t("settings.lockoutMinutes")}</Label>
                  <Input
                    id="lockoutMinutes"
                    dir="ltr"
                    type="number"
                    min={BOUNDS.lockoutMinutes.min}
                    max={BOUNDS.lockoutMinutes.max}
                    value={form.lockoutMinutes}
                    onChange={(e) => setForm({ ...form, lockoutMinutes: e.target.value })}
                  />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="maxUploadMb">{t("settings.maxUploadMb")}</Label>
                  <Input
                    id="maxUploadMb"
                    dir="ltr"
                    type="number"
                    min={BOUNDS.maxUploadMb.min}
                    max={BOUNDS.maxUploadMb.max}
                    value={form.maxUploadMb}
                    onChange={(e) => setForm({ ...form, maxUploadMb: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("settings.maxUploadMbCeilingHint", { max: MAX_UPLOAD_MB_CEILING })}
                  </p>
                </div>
              </div>

              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? <Spinner className="border-primary-foreground" /> : t("common.save")}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("settings.auditLogTitle")}</CardTitle>
          <CardDescription>{t("settings.auditLogHint")}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {auditLoading && <div className="p-4">…</div>}
          {auditLog && auditLog.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground">{t("settings.auditLogEmpty")}</p>
          )}
          {auditLog && auditLog.length > 0 && (
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="p-3 text-start">{t("settings.auditLogWhen")}</th>
                  <th className="p-3 text-start">{t("settings.auditLogWho")}</th>
                  <th className="p-3 text-start">{t("settings.auditLogChanges")}</th>
                </tr>
              </thead>
              <tbody>
                {auditLog.map((entry) => (
                  <tr key={entry.id} className="border-b last:border-0 align-top">
                    <td className="p-3 whitespace-nowrap text-muted-foreground" dir="ltr">
                      {new Date(entry.createdAt).toLocaleString()}
                    </td>
                    <td className="p-3">
                      <div className="font-medium">{entry.platformAdmin.name}</div>
                      <div className="text-xs text-muted-foreground" dir="ltr">
                        {entry.platformAdmin.email}
                      </div>
                    </td>
                    <td className="p-3">
                      <ul className="space-y-1">
                        {Object.entries(entry.meta.changes ?? {}).map(([key, change]) => (
                          <li key={key}>
                            <span className="font-medium">{t(`settings.${key}`)}</span>:{" "}
                            <span dir="ltr">{formatChangeValue(key, change.from)}</span>
                            {" → "}
                            <span dir="ltr">{formatChangeValue(key, change.to)}</span>
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
