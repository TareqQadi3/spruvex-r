import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  Spinner,
  Switch,
  Textarea,
} from "@spruvex-r/ui";

import { api, ApiError } from "../../lib/api";

interface TenantInfo {
  id: string;
  name: string;
  nameEn?: string;
  slug: string;
  logoUrl?: string;
  legalName?: string;
  type?: string;
  country: string;
  currency: string;
  defaultLocale: string;
  vatNumber?: string;
  crNumber?: string;
  address?: string;
  vatRate: string;
  publicBaseUrl: string;
}

interface ZatcaForm {
  legalName: string;
  vatNumber: string;
  crNumber: string;
  address: string;
}

interface ZatcaSettings {
  enabled: boolean;
  environment: "sandbox" | "simulation" | "production";
  hasCertificate: boolean;
  hasPrivateKey: boolean;
  hasToken: boolean;
  hasSecret: boolean;
  fullyConfigured: boolean;
}

interface ZatcaSettingsForm {
  enabled: boolean;
  environment: "sandbox" | "simulation" | "production";
  certificatePem: string;
  privateKeyPem: string;
  csidToken: string;
  csidSecret: string;
}

const EMPTY_ZATCA_FORM: ZatcaSettingsForm = {
  enabled: false,
  environment: "sandbox",
  certificatePem: "",
  privateKeyPem: "",
  csidToken: "",
  csidSecret: "",
};

export function SettingsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["tenant"],
    queryFn: () => api<TenantInfo>("/tenant"),
  });

  const [form, setForm] = useState<ZatcaForm>({
    legalName: "",
    vatNumber: "",
    crNumber: "",
    address: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) {
      setForm({
        legalName: data.legalName ?? "",
        vatNumber: data.vatNumber ?? "",
        crNumber: data.crNumber ?? "",
        address: data.address ?? "",
      });
    }
  }, [data]);

  const save = useMutation({
    mutationFn: () =>
      api("/tenant", {
        method: "PATCH",
        body: JSON.stringify({
          ...(form.legalName ? { legalName: form.legalName } : {}),
          ...(form.vatNumber ? { vatNumber: form.vatNumber } : {}),
          ...(form.crNumber ? { crNumber: form.crNumber } : {}),
          ...(form.address ? { address: form.address } : {}),
        }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["tenant"] });
      setSaved(true);
      setError(null);
      setTimeout(() => setSaved(false), 3000);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t("common.error")),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate();
  }

  const { data: zatca, isLoading: zatcaLoading } = useQuery({
    queryKey: ["zatca-settings"],
    queryFn: () => api<ZatcaSettings>("/tenant/zatca-settings"),
  });
  const [zatcaForm, setZatcaForm] = useState<ZatcaSettingsForm>(EMPTY_ZATCA_FORM);
  const [zatcaError, setZatcaError] = useState<string | null>(null);
  const [zatcaSaved, setZatcaSaved] = useState(false);

  useEffect(() => {
    if (zatca) {
      setZatcaForm({ ...EMPTY_ZATCA_FORM, enabled: zatca.enabled, environment: zatca.environment });
    }
  }, [zatca]);

  const saveZatca = useMutation({
    mutationFn: () =>
      api("/tenant/zatca-settings", {
        method: "PATCH",
        body: JSON.stringify({
          enabled: zatcaForm.enabled,
          environment: zatcaForm.environment,
          ...(zatcaForm.certificatePem ? { certificatePem: zatcaForm.certificatePem } : {}),
          ...(zatcaForm.privateKeyPem ? { privateKeyPem: zatcaForm.privateKeyPem } : {}),
          ...(zatcaForm.csidToken ? { csidToken: zatcaForm.csidToken } : {}),
          ...(zatcaForm.csidSecret ? { csidSecret: zatcaForm.csidSecret } : {}),
        }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["zatca-settings"] });
      setZatcaForm((f) => ({ ...f, certificatePem: "", privateKeyPem: "", csidToken: "", csidSecret: "" }));
      setZatcaSaved(true);
      setZatcaError(null);
      setTimeout(() => setZatcaSaved(false), 3000);
    },
    onError: (e) => setZatcaError(e instanceof ApiError ? e.message : t("common.error")),
  });

  function submitZatca(event: FormEvent) {
    event.preventDefault();
    saveZatca.mutate();
  }

  const rows: Array<[string, string | undefined]> = data
    ? [
        [t("onboarding.restaurantName"), data.name],
        [t("onboarding.restaurantNameEn"), data.nameEn],
        [t("onboarding.type"), data.type ? t(`onboarding.types.${data.type}`) : undefined],
        [t("onboarding.country"), data.country],
        [t("settings.currency"), data.currency],
        [t("settings.vatRate"), data.vatRate ? `${data.vatRate}%` : undefined],
      ]
    : [];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">{t("settings.title")}</h1>
      {isLoading && <Spinner />}
      {data && (
        <div className="grid max-w-3xl grid-cols-1 gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>{t("settings.restaurantInfo")}</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="divide-y">
                {rows.map(([label, value]) => (
                  <div key={label} className="flex justify-between py-3 text-sm">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="font-medium">{value ?? t("settings.notSet")}</dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("settings.zatca")}</CardTitle>
              <CardDescription>{t("settings.zatcaHint")}</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={submit} className="space-y-4">
                {error && <Alert variant="destructive">{error}</Alert>}
                {saved && <Alert>{t("settings.saved")}</Alert>}
                <div className="space-y-2">
                  <Label htmlFor="legalName">{t("settings.legalName")}</Label>
                  <Input
                    id="legalName"
                    value={form.legalName}
                    onChange={(e) => setForm({ ...form, legalName: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="vatNumber">{t("settings.vatNumber")}</Label>
                  <Input
                    id="vatNumber"
                    dir="ltr"
                    maxLength={15}
                    value={form.vatNumber}
                    onChange={(e) => setForm({ ...form, vatNumber: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="crNumber">{t("settings.crNumber")}</Label>
                  <Input
                    id="crNumber"
                    dir="ltr"
                    value={form.crNumber}
                    onChange={(e) => setForm({ ...form, crNumber: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="address">{t("settings.address")}</Label>
                  <Input
                    id="address"
                    value={form.address}
                    onChange={(e) => setForm({ ...form, address: e.target.value })}
                  />
                </div>
                <Button type="submit" disabled={save.isPending}>
                  {save.isPending ? <Spinner className="border-primary-foreground" /> : t("common.save")}
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>{t("settings.zatcaPhase2")}</CardTitle>
              <CardDescription>{t("settings.zatcaPhase2Hint")}</CardDescription>
            </CardHeader>
            <CardContent>
              {zatcaLoading && <Spinner />}
              {zatca && (
                <form onSubmit={submitZatca} className="space-y-4">
                  {zatcaError && <Alert variant="destructive">{zatcaError}</Alert>}
                  {zatcaSaved && <Alert>{t("settings.saved")}</Alert>}

                  <div className="flex items-center gap-3">
                    <Switch
                      checked={zatcaForm.enabled}
                      aria-label={t("settings.zatcaPhase2Enable")}
                      onCheckedChange={(enabled) => setZatcaForm({ ...zatcaForm, enabled })}
                    />
                    <span className="text-sm font-medium">{t("settings.zatcaPhase2Enable")}</span>
                  </div>

                  <Alert>
                    {zatca.fullyConfigured ? t("settings.zatcaConfigured") : t("settings.zatcaNotConfigured")}
                  </Alert>

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="zatca-env">{t("settings.zatcaEnvironment")}</Label>
                      <Select
                        id="zatca-env"
                        value={zatcaForm.environment}
                        onChange={(e) =>
                          setZatcaForm({
                            ...zatcaForm,
                            environment: e.target.value as ZatcaSettingsForm["environment"],
                          })
                        }
                      >
                        <option value="sandbox">{t("settings.zatcaSandbox")}</option>
                        <option value="simulation">{t("settings.zatcaSimulation")}</option>
                        <option value="production">{t("settings.zatcaProduction")}</option>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="zatca-token">{t("settings.zatcaToken")}</Label>
                      <Input
                        id="zatca-token"
                        dir="ltr"
                        type="password"
                        placeholder={zatca.hasToken ? "••••••••" : ""}
                        value={zatcaForm.csidToken}
                        onChange={(e) => setZatcaForm({ ...zatcaForm, csidToken: e.target.value })}
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="zatca-secret">{t("settings.zatcaSecret")}</Label>
                    <Input
                      id="zatca-secret"
                      dir="ltr"
                      type="password"
                      placeholder={zatca.hasSecret ? "••••••••" : ""}
                      value={zatcaForm.csidSecret}
                      onChange={(e) => setZatcaForm({ ...zatcaForm, csidSecret: e.target.value })}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="zatca-cert">{t("settings.zatcaCertificate")}</Label>
                    <Textarea
                      id="zatca-cert"
                      dir="ltr"
                      rows={4}
                      placeholder={zatca.hasCertificate ? "•••• (configured) ••••" : "-----BEGIN CERTIFICATE-----"}
                      value={zatcaForm.certificatePem}
                      onChange={(e) => setZatcaForm({ ...zatcaForm, certificatePem: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="zatca-key">{t("settings.zatcaPrivateKey")}</Label>
                    <Textarea
                      id="zatca-key"
                      dir="ltr"
                      rows={4}
                      placeholder={zatca.hasPrivateKey ? "•••• (configured) ••••" : "-----BEGIN EC PRIVATE KEY-----"}
                      value={zatcaForm.privateKeyPem}
                      onChange={(e) => setZatcaForm({ ...zatcaForm, privateKeyPem: e.target.value })}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">{t("settings.zatcaCredentialsHint")}</p>

                  <Button type="submit" disabled={saveZatca.isPending}>
                    {saveZatca.isPending ? <Spinner className="border-primary-foreground" /> : t("common.save")}
                  </Button>
                </form>
              )}
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>{t("settings.publicLinks")}</CardTitle>
              <CardDescription>{t("settings.publicLinksHint")}</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="rounded-md bg-muted p-3 text-sm" dir="ltr">
                {data.publicBaseUrl}/restaurant/{data.slug}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                {t("settings.qrLinksHint")}
              </p>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
