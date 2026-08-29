import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Badge,
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
// Namespace import — see packages/ui/src/apply-theme.ts for why a named
// import of a const re-exported through @spruvex-r/types' barrel file
// breaks Vite/Rollup's static CJS-interop analysis.
import * as SpruvexTypes from "@spruvex-r/types";

import { api, ApiError } from "../../lib/api";
import { catalogApi } from "../../lib/catalog-api";

const { DELIVERY_PROVIDERS, PAYMENT_GATEWAY_PROVIDERS, NFC_PROVIDERS } = SpruvexTypes;

interface ConnectionSummary {
  id: string;
  category: "delivery_platform" | "payment_gateway" | "nfc_terminal" | "whatsapp";
  provider: string;
  branchId: string | null;
  isEnabled: boolean;
  environment: string;
  config: Record<string, unknown>;
  hasSecret: boolean;
  hasWebhookSecret: boolean;
  lastErrorMessage: string | null;
  status: "connected" | "disconnected" | "error";
  webhookUrl: string | null;
}

interface Branch {
  id: string;
  name: string;
}

function StatusBadge({ connection, t }: { connection: ConnectionSummary | undefined; t: (key: string) => string }) {
  if (!connection) return <Badge variant="muted">{t("integrations.statusDisconnected")}</Badge>;
  if (connection.status === "error") {
    return (
      <Badge variant="destructive" title={connection.lastErrorMessage ?? undefined}>
        {t("integrations.statusError")}
      </Badge>
    );
  }
  if (connection.status === "connected") {
    return <Badge variant="success">{t("integrations.statusConnected")}</Badge>;
  }
  return <Badge variant="muted">{t("integrations.statusDisconnected")}</Badge>;
}

export function IntegrationsPage() {
  const { t } = useTranslation();
  const { data: connections, isLoading } = useQuery({
    queryKey: ["integration-connections"],
    queryFn: () => api<ConnectionSummary[]>("/integrations/connections"),
  });
  const { data: branches } = useQuery({
    queryKey: ["branches"],
    queryFn: () => api<Branch[]>("/branches"),
  });

  const byCategory = (category: ConnectionSummary["category"]) =>
    (connections ?? []).find((c) => c.category === category);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("integrations.title")}</h1>
        <p className="text-muted-foreground">{t("integrations.subtitle")}</p>
      </div>
      {isLoading && <Spinner />}
      {connections && (
        <div className="grid max-w-3xl grid-cols-1 gap-6">
          <DeliverySection connection={byCategory("delivery_platform")} branches={branches ?? []} />
          <GatewaySection connection={byCategory("payment_gateway")} />
          <NfcSection connection={byCategory("nfc_terminal")} branches={branches ?? []} />
          <WhatsappSection connection={byCategory("whatsapp")} />
        </div>
      )}
    </div>
  );
}

// --- Delivery platforms ---------------------------------------------------

function DeliverySection({
  connection,
  branches,
}: {
  connection: ConnectionSummary | undefined;
  branches: Branch[];
}) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [provider] = useState("hungerstation");
  const [branchId, setBranchId] = useState(connection?.branchId ?? "");
  const [isEnabled, setIsEnabled] = useState(connection?.isEnabled ?? false);
  const [storeId, setStoreId] = useState((connection?.config.externalStoreId as string) ?? "");
  const [apiKey, setApiKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: () =>
      api<ConnectionSummary>("/integrations/connections/delivery_platform", {
        method: "POST",
        body: JSON.stringify({
          provider,
          branchId: branchId || undefined,
          isEnabled,
          config: { externalStoreId: storeId },
          ...(apiKey ? { secret: apiKey } : {}),
          ...(webhookSecret ? { webhookSecret } : {}),
        }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["integration-connections"] });
      setApiKey("");
      setWebhookSecret("");
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

  const preset = DELIVERY_PROVIDERS[provider as keyof typeof DELIVERY_PROVIDERS];

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>{t("integrations.deliveryTitle")}</CardTitle>
          <CardDescription>{t("integrations.deliveryHint")}</CardDescription>
        </div>
        <StatusBadge connection={connection} t={t} />
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          {error && <Alert variant="destructive">{error}</Alert>}
          {saved && <Alert>{t("integrations.savedMessage")}</Alert>}

          <div className="space-y-2">
            <Label>{t("integrations.deliveryProviderLabel")}</Label>
            <p className="text-sm">
              {i18n.language === "en" ? preset.nameEn : preset.nameAr} — {i18n.language === "en" ? preset.descriptionEn : preset.descriptionAr}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="delivery-branch">{t("integrations.branchLabel")}</Label>
            <Select id="delivery-branch" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              <option value="">{t("integrations.selectBranch")}</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </div>

          <div className="flex items-center gap-3">
            <Switch checked={isEnabled} aria-label={t("integrations.enableLabel")} onCheckedChange={setIsEnabled} />
            <span className="text-sm font-medium">{t("integrations.enableLabel")}</span>
          </div>

          <div className="space-y-2">
            <Label htmlFor="delivery-store-id">{t("integrations.deliveryStoreIdLabel")}</Label>
            <p className="text-xs text-muted-foreground">{t("integrations.deliveryStoreIdHint")}</p>
            <Input id="delivery-store-id" dir="ltr" value={storeId} onChange={(e) => setStoreId(e.target.value)} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="delivery-api-key">{t("integrations.deliveryApiKeyLabel")}</Label>
            <Input
              id="delivery-api-key"
              dir="ltr"
              type="password"
              placeholder={connection?.hasSecret ? "••••••••" : ""}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="delivery-webhook-secret">{t("integrations.deliveryWebhookSecretLabel")}</Label>
            <p className="text-xs text-muted-foreground">{t("integrations.deliveryWebhookSecretHint")}</p>
            <Input
              id="delivery-webhook-secret"
              dir="ltr"
              type="password"
              placeholder={connection?.hasWebhookSecret ? "••••••••" : ""}
              value={webhookSecret}
              onChange={(e) => setWebhookSecret(e.target.value)}
            />
          </div>

          {connection?.webhookUrl && (
            <div className="space-y-2">
              <Label>{t("integrations.deliveryWebhookUrlLabel")}</Label>
              <p className="text-xs text-muted-foreground">{t("integrations.deliveryWebhookUrlHint")}</p>
              <p className="break-all rounded-md bg-muted p-2 text-xs" dir="ltr">
                {connection.webhookUrl}
              </p>
            </div>
          )}

          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? <Spinner className="border-primary-foreground" /> : t("integrations.saveButton")}
          </Button>
        </form>

        {connection && <DeliveryMappings connectionId={connection.id} />}
      </CardContent>
    </Card>
  );
}

interface Product {
  id: string;
  name: string;
  nameEn: string | null;
}

interface DeliveryMapping {
  id: string;
  productId: string;
  externalItemId: string;
  externalItemName: string | null;
  product: { id: string; name: string; nameEn: string | null; sku: string | null };
}

function DeliveryMappings({ connectionId }: { connectionId: string }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { data: mappings } = useQuery({
    queryKey: ["delivery-mappings", connectionId],
    queryFn: () => api<DeliveryMapping[]>(`/integrations/delivery/mappings?connectionId=${connectionId}`),
  });
  const { data: products } = useQuery({
    queryKey: ["products-for-mapping"],
    queryFn: () => catalogApi.listProducts(),
  });

  const [productId, setProductId] = useState("");
  const [externalItemId, setExternalItemId] = useState("");
  const [externalItemName, setExternalItemName] = useState("");

  const add = useMutation({
    mutationFn: () =>
      api("/integrations/delivery/mappings", {
        method: "POST",
        body: JSON.stringify({
          connectionId,
          productId,
          externalItemId,
          ...(externalItemName ? { externalItemName } : {}),
        }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["delivery-mappings", connectionId] });
      setProductId("");
      setExternalItemId("");
      setExternalItemName("");
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/integrations/delivery/mappings/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["delivery-mappings", connectionId] }),
  });

  return (
    <div className="mt-6 space-y-3 border-t pt-4">
      <h3 className="text-sm font-semibold">{t("integrations.deliveryMappingsTitle")}</h3>
      <p className="text-xs text-muted-foreground">{t("integrations.deliveryMappingsHint")}</p>

      {mappings && mappings.length > 0 && (
        <ul className="divide-y rounded-md border">
          {mappings.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-2 p-2 text-sm">
              <span>
                {i18n.language === "en" && m.product.nameEn ? m.product.nameEn : m.product.name}
                <span className="text-muted-foreground" dir="ltr">
                  {" "}
                  → {m.externalItemId}
                </span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => remove.mutate(m.id)}>
                {t("common.delete")}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Select value={productId} onChange={(e) => setProductId(e.target.value)}>
          <option value="">{t("integrations.deliveryMappingSelectProduct")}</option>
          {(products ?? []).map((p: Product) => (
            <option key={p.id} value={p.id}>
              {i18n.language === "en" && p.nameEn ? p.nameEn : p.name}
            </option>
          ))}
        </Select>
        <Input
          dir="ltr"
          placeholder={t("integrations.deliveryMappingExternalId")}
          value={externalItemId}
          onChange={(e) => setExternalItemId(e.target.value)}
        />
        <Input
          placeholder={t("integrations.deliveryMappingExternalName")}
          value={externalItemName}
          onChange={(e) => setExternalItemName(e.target.value)}
        />
      </div>
      <Button
        size="sm"
        variant="outline"
        disabled={!productId || !externalItemId || add.isPending}
        onClick={() => add.mutate()}
      >
        {t("integrations.deliveryMappingAdd")}
      </Button>
    </div>
  );
}

// --- Payment gateway -------------------------------------------------------

function GatewaySection({ connection }: { connection: ConnectionSummary | undefined }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState(connection?.provider ?? "moyasar");
  const [environment, setEnvironment] = useState(connection?.environment ?? "test");
  const [isEnabled, setIsEnabled] = useState(connection?.isEnabled ?? false);
  const [secret, setSecret] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (connection) {
      setProvider(connection.provider);
      setEnvironment(connection.environment);
      setIsEnabled(connection.isEnabled);
    }
  }, [connection]);

  const save = useMutation({
    mutationFn: () =>
      api<ConnectionSummary>("/integrations/connections/payment_gateway", {
        method: "POST",
        body: JSON.stringify({
          provider,
          isEnabled,
          environment,
          ...(secret ? { secret } : {}),
          ...(webhookSecret ? { webhookSecret } : {}),
        }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["integration-connections"] });
      setSecret("");
      setWebhookSecret("");
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

  const preset = PAYMENT_GATEWAY_PROVIDERS[provider as keyof typeof PAYMENT_GATEWAY_PROVIDERS];

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>{t("integrations.gatewayTitle")}</CardTitle>
          <CardDescription>{t("integrations.gatewayHint")}</CardDescription>
        </div>
        <StatusBadge connection={connection} t={t} />
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          {error && <Alert variant="destructive">{error}</Alert>}
          {saved && <Alert>{t("integrations.savedMessage")}</Alert>}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="gateway-provider">{t("integrations.gatewayProviderLabel")}</Label>
              <Select id="gateway-provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
                {Object.values(PAYMENT_GATEWAY_PROVIDERS).map((p) => (
                  <option key={p.key} value={p.key}>
                    {i18n.language === "en" ? p.nameEn : p.nameAr}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="gateway-env">{t("integrations.gatewayEnvironmentLabel")}</Label>
              <Select id="gateway-env" value={environment} onChange={(e) => setEnvironment(e.target.value)}>
                <option value="test">{t("integrations.gatewayEnvironmentTest")}</option>
                <option value="live">{t("integrations.gatewayEnvironmentLive")}</option>
              </Select>
            </div>
          </div>

          <p className="text-sm text-muted-foreground">
            {i18n.language === "en" ? preset.descriptionEn : preset.descriptionAr}
          </p>
          {provider === "hyperpay" && <Alert>{t("integrations.gatewayComingSoon")}</Alert>}

          <div className="flex items-center gap-3">
            <Switch checked={isEnabled} aria-label={t("integrations.enableLabel")} onCheckedChange={setIsEnabled} />
            <span className="text-sm font-medium">{t("integrations.enableLabel")}</span>
          </div>

          <div className="space-y-2">
            <Label htmlFor="gateway-secret">{t("integrations.gatewaySecretKeyLabel")}</Label>
            <Input
              id="gateway-secret"
              dir="ltr"
              type="password"
              placeholder={connection?.hasSecret ? "••••••••" : ""}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="gateway-webhook-secret">{t("integrations.gatewayWebhookSecretLabel")}</Label>
            <Input
              id="gateway-webhook-secret"
              dir="ltr"
              type="password"
              placeholder={connection?.hasWebhookSecret ? "••••••••" : ""}
              value={webhookSecret}
              onChange={(e) => setWebhookSecret(e.target.value)}
            />
          </div>

          {connection?.webhookUrl && (
            <div className="space-y-2">
              <Label>{t("integrations.gatewayWebhookUrlLabel")}</Label>
              <p className="break-all rounded-md bg-muted p-2 text-xs" dir="ltr">
                {connection.webhookUrl}
              </p>
            </div>
          )}

          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? <Spinner className="border-primary-foreground" /> : t("integrations.saveButton")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// --- NFC terminal -----------------------------------------------------------

function NfcSection({ connection, branches }: { connection: ConnectionSummary | undefined; branches: Branch[] }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [branchId, setBranchId] = useState(connection?.branchId ?? "");
  const [isEnabled, setIsEnabled] = useState(connection?.isEnabled ?? false);
  const [terminalId, setTerminalId] = useState((connection?.config.terminalId as string) ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: () =>
      api<ConnectionSummary>("/integrations/connections/nfc_terminal", {
        method: "POST",
        body: JSON.stringify({
          provider: "geidea",
          branchId: branchId || undefined,
          isEnabled,
          config: { terminalId },
        }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["integration-connections"] });
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

  const preset = NFC_PROVIDERS.geidea;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>{t("integrations.nfcTitle")}</CardTitle>
          <CardDescription>{t("integrations.nfcHint")}</CardDescription>
        </div>
        <StatusBadge connection={connection} t={t} />
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          {error && <Alert variant="destructive">{error}</Alert>}
          {saved && <Alert>{t("integrations.savedMessage")}</Alert>}
          <Alert>{t("integrations.nfcStructureNotice")}</Alert>

          <div className="space-y-2">
            <Label>{t("integrations.nfcProviderLabel")}</Label>
            <p className="text-sm">
              {i18n.language === "en" ? preset.nameEn : preset.nameAr} — {i18n.language === "en" ? preset.descriptionEn : preset.descriptionAr}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="nfc-branch">{t("integrations.branchLabel")}</Label>
            <Select id="nfc-branch" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              <option value="">{t("integrations.selectBranch")}</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </div>

          <div className="flex items-center gap-3">
            <Switch checked={isEnabled} aria-label={t("integrations.enableLabel")} onCheckedChange={setIsEnabled} />
            <span className="text-sm font-medium">{t("integrations.enableLabel")}</span>
          </div>

          <div className="space-y-2">
            <Label htmlFor="nfc-terminal-id">{t("integrations.nfcTerminalIdLabel")}</Label>
            <Input id="nfc-terminal-id" dir="ltr" value={terminalId} onChange={(e) => setTerminalId(e.target.value)} />
          </div>

          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? <Spinner className="border-primary-foreground" /> : t("integrations.saveButton")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// --- WhatsApp ---------------------------------------------------------------

function WhatsappSection({ connection }: { connection: ConnectionSummary | undefined }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [phoneNumberId, setPhoneNumberId] = useState((connection?.config.phoneNumberId as string) ?? "");
  const [accessToken, setAccessToken] = useState("");
  const [isEnabled, setIsEnabled] = useState(connection?.isEnabled ?? false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: () =>
      api<ConnectionSummary>("/integrations/connections/whatsapp", {
        method: "POST",
        body: JSON.stringify({
          provider: "whatsapp_cloud",
          isEnabled,
          config: { phoneNumberId },
          ...(accessToken ? { secret: accessToken } : {}),
        }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["integration-connections"] });
      setAccessToken("");
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

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>{t("integrations.whatsappTitle")}</CardTitle>
          <CardDescription>{t("integrations.whatsappHint")}</CardDescription>
        </div>
        <StatusBadge connection={connection} t={t} />
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          {error && <Alert variant="destructive">{error}</Alert>}
          {saved && <Alert>{t("integrations.savedMessage")}</Alert>}

          <div className="flex items-center gap-3">
            <Switch checked={isEnabled} aria-label={t("integrations.enableLabel")} onCheckedChange={setIsEnabled} />
            <span className="text-sm font-medium">{t("integrations.enableLabel")}</span>
          </div>

          <div className="space-y-2">
            <Label htmlFor="wa-phone-id">{t("integrations.whatsappPhoneNumberIdLabel")}</Label>
            <Input
              id="wa-phone-id"
              dir="ltr"
              value={phoneNumberId}
              onChange={(e) => setPhoneNumberId(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="wa-token">{t("integrations.whatsappAccessTokenLabel")}</Label>
            <Input
              id="wa-token"
              dir="ltr"
              type="password"
              placeholder={connection?.hasSecret ? "••••••••" : ""}
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
            />
          </div>

          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? <Spinner className="border-primary-foreground" /> : t("integrations.saveButton")}
          </Button>
        </form>

        <WhatsappTemplates />
      </CardContent>
    </Card>
  );
}

interface WhatsappTemplateEntry {
  key: string;
  nameAr: string;
  nameEn: string;
  bodyAr: string;
  variables: Array<{ key: string; nameAr: string; nameEn: string; example: string }>;
  override: {
    customBodyAr: string | null;
    approvalStatus: string;
    metaTemplateName: string | null;
  } | null;
}

function WhatsappTemplates() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { data: templates } = useQuery({
    queryKey: ["whatsapp-templates"],
    queryFn: () => api<WhatsappTemplateEntry[]>("/integrations/whatsapp/templates"),
  });

  return (
    <div className="mt-6 space-y-4 border-t pt-4">
      <div>
        <h3 className="text-sm font-semibold">{t("integrations.whatsappTemplatesTitle")}</h3>
        <p className="text-xs text-muted-foreground">{t("integrations.whatsappTemplatesHint")}</p>
      </div>
      {!templates && <Spinner />}
      {templates?.map((template) => (
        <WhatsappTemplateCard
          key={template.key}
          template={template}
          language={i18n.language}
          onSaved={() => queryClient.invalidateQueries({ queryKey: ["whatsapp-templates"] })}
        />
      ))}
    </div>
  );
}

function WhatsappTemplateCard({
  template,
  language,
  onSaved,
}: {
  template: WhatsappTemplateEntry;
  language: string;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [customBodyAr, setCustomBodyAr] = useState(template.override?.customBodyAr ?? "");
  const [approvalStatus, setApprovalStatus] = useState(template.override?.approvalStatus ?? "not_submitted");
  const [metaTemplateName, setMetaTemplateName] = useState(template.override?.metaTemplateName ?? "");

  const save = useMutation({
    mutationFn: () =>
      api("/integrations/whatsapp/templates", {
        method: "POST",
        body: JSON.stringify({
          templateKey: template.key,
          customBodyAr: customBodyAr || null,
          approvalStatus,
          metaTemplateName: metaTemplateName || null,
        }),
      }),
    onSuccess: onSaved,
  });

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div>
        <p className="font-medium">{language === "en" ? template.nameEn : template.nameAr}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t("integrations.whatsappSuggestedWording")}</p>
        <p className="rounded-md bg-muted p-2 text-sm">{template.bodyAr}</p>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">{t("integrations.whatsappVariablesLabel")}</p>
        <p className="text-xs" dir="ltr">
          {template.variables.map((v, i) => `{{${i + 1}}}=${v.key}`).join("  ")}
        </p>
      </div>
      <div className="space-y-2">
        <Label>{t("integrations.whatsappTemplateCustomBody")}</Label>
        <Textarea rows={2} value={customBodyAr} onChange={(e) => setCustomBodyAr(e.target.value)} />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>{t("integrations.whatsappTemplateApprovalStatus")}</Label>
          <Select value={approvalStatus} onChange={(e) => setApprovalStatus(e.target.value)}>
            <option value="not_submitted">{t("integrations.whatsappApprovalNotSubmitted")}</option>
            <option value="pending">{t("integrations.whatsappApprovalPending")}</option>
            <option value="approved">{t("integrations.whatsappApprovalApproved")}</option>
            <option value="rejected">{t("integrations.whatsappApprovalRejected")}</option>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>{t("integrations.whatsappTemplateMetaName")}</Label>
          <Input dir="ltr" value={metaTemplateName} onChange={(e) => setMetaTemplateName(e.target.value)} />
        </div>
      </div>
      <Button size="sm" variant="outline" disabled={save.isPending} onClick={() => save.mutate()}>
        {save.isPending ? <Spinner className="border-primary-foreground" /> : t("integrations.saveButton")}
      </Button>
    </div>
  );
}
