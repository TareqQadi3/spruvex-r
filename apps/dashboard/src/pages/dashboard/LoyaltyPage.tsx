import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
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
} from "@spruvex-r/ui";
// Namespace import — see IntegrationsPage.tsx for why a named import of a
// const re-exported through @spruvex-r/types' barrel breaks Vite/Rollup's
// static CJS-interop analysis.
import * as SpruvexTypes from "@spruvex-r/types";

import { api, ApiError } from "../../lib/api";
import { catalogApi, localizedName } from "../../lib/catalog-api";
import { loyaltyApi, type LoyaltyConfigRow, type LoyaltyProgramType } from "../../lib/loyalty-api";

const { LOYALTY_PROGRAMS } = SpruvexTypes;

interface Branch {
  id: string;
  name: string;
  nameEn: string | null;
}

interface TierRow {
  key: string;
  nameAr: string;
  minSpend: string;
  discountPercent: string;
}

export function LoyaltyPage() {
  const { t, i18n } = useTranslation();
  const [branchId, setBranchId] = useState("");

  const branches = useQuery({ queryKey: ["branches"], queryFn: () => api<Branch[]>("/branches") });
  const configs = useQuery({
    queryKey: ["loyalty-configs", branchId],
    queryFn: () => loyaltyApi.listConfigs(branchId || undefined),
  });
  const categories = useQuery({ queryKey: ["catalog", "categories"], queryFn: catalogApi.listCategories });
  const products = useQuery({ queryKey: ["catalog", "products"], queryFn: () => catalogApi.listProducts() });

  const byType = (type: LoyaltyProgramType) => configs.data?.find((c) => c.type === type);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t("loyalty.title")}</h1>
          <p className="text-muted-foreground">{t("loyalty.subtitle")}</p>
        </div>
        <Select className="w-56" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
          <option value="">{t("loyalty.allBranches")}</option>
          {branches.data?.map((branch) => (
            <option key={branch.id} value={branch.id}>
              {localizedName(branch, i18n.language)}
            </option>
          ))}
        </Select>
      </div>

      {(configs.isLoading || categories.isLoading || products.isLoading) && <Spinner />}

      {configs.data && (
        <div className="grid max-w-3xl grid-cols-1 gap-6">
          <StampCardSection
            config={byType("stamp_card")}
            branchId={branchId}
            categories={categories.data ?? []}
            products={products.data ?? []}
          />
          <SpendThresholdSection config={byType("spend_threshold")} branchId={branchId} />
          <PointsSection config={byType("points_per_riyal")} branchId={branchId} />
          <TierSection config={byType("tier")} branchId={branchId} />
        </div>
      )}
    </div>
  );
}

function ProgramHeader({
  type,
  config,
  branchId,
}: {
  type: LoyaltyProgramType;
  config: LoyaltyConfigRow | undefined;
  branchId: string;
}) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const meta = LOYALTY_PROGRAMS[type];

  const removeOverride = useMutation({
    mutationFn: () => loyaltyApi.removeOverride(type, branchId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["loyalty-configs"] }),
  });

  return (
    <CardHeader>
      <div className="flex items-center justify-between gap-2">
        <CardTitle className="text-base">{localizedName({ name: meta.nameAr, nameEn: meta.nameEn }, i18n.language)}</CardTitle>
        <div className="flex items-center gap-2">
          {config?.isEnabled ? (
            <Badge variant="success">{t("loyalty.enabled")}</Badge>
          ) : (
            <Badge variant="muted">{t("loyalty.disabled")}</Badge>
          )}
          {branchId && config?.isOverride && (
            <Button type="button" variant="ghost" size="sm" onClick={() => removeOverride.mutate()}>
              {t("loyalty.resetToDefault")}
            </Button>
          )}
        </div>
      </div>
      <CardDescription>{localizedName({ name: meta.descriptionAr, nameEn: meta.descriptionEn }, i18n.language)}</CardDescription>
    </CardHeader>
  );
}

// --- Stamp card ------------------------------------------------------------

function StampCardSection({
  config,
  branchId,
  categories,
  products,
}: {
  config: LoyaltyConfigRow | undefined;
  branchId: string;
  categories: Array<{ id: string; name: string; nameEn: string | null }>;
  products: Array<{ id: string; name: string; nameEn: string | null }>;
}) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [isEnabled, setIsEnabled] = useState(false);
  const [stampsRequired, setStampsRequired] = useState("10");
  const [earnMode, setEarnMode] = useState<"product" | "category">("product");
  const [earnProductId, setEarnProductId] = useState("");
  const [earnCategoryId, setEarnCategoryId] = useState("");
  const [rewardProductId, setRewardProductId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setIsEnabled(config?.isEnabled ?? false);
    const cfg = (config?.config ?? {}) as Record<string, string>;
    setStampsRequired(cfg.stampsRequired ?? "10");
    setEarnMode(cfg.earnCategoryId ? "category" : "product");
    setEarnProductId(cfg.earnProductId ?? "");
    setEarnCategoryId(cfg.earnCategoryId ?? "");
    setRewardProductId(cfg.rewardProductId ?? "");
  }, [config]);

  const save = useMutation({
    mutationFn: () =>
      loyaltyApi.upsertConfig("stamp_card", {
        branchId: branchId || undefined,
        isEnabled,
        config: {
          stampsRequired: Number(stampsRequired),
          ...(earnMode === "product" ? { earnProductId } : { earnCategoryId }),
          rewardProductId,
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["loyalty-configs"] });
      setError(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t("common.error")),
  });

  return (
    <Card>
      <ProgramHeader type="stamp_card" config={config} branchId={branchId} />
      <CardContent className="space-y-4">
        {error && <Alert variant="destructive">{error}</Alert>}
        {saved && <Alert>{t("common.saved")}</Alert>}
        <div className="flex items-center gap-2">
          <Switch checked={isEnabled} onCheckedChange={setIsEnabled} aria-label={t("loyalty.enabled")} />
          <span className="text-sm">{t("loyalty.enableThisProgram")}</span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>{t("loyalty.stamp.stampsRequired")}</Label>
            <Input
              dir="ltr"
              inputMode="numeric"
              value={stampsRequired}
              onChange={(e) => setStampsRequired(e.target.value)}
            />
          </div>
          <div>
            <Label>{t("loyalty.stamp.rewardProduct")}</Label>
            <Select value={rewardProductId} onChange={(e) => setRewardProductId(e.target.value)}>
              <option value="" disabled>
                —
              </option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {localizedName(p, i18n.language)}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div>
          <Label>{t("loyalty.stamp.earnMode")}</Label>
          <div className="mt-1 flex gap-4 text-sm">
            <label className="flex items-center gap-1">
              <input type="radio" checked={earnMode === "product"} onChange={() => setEarnMode("product")} />
              {t("loyalty.stamp.earnByProduct")}
            </label>
            <label className="flex items-center gap-1">
              <input type="radio" checked={earnMode === "category"} onChange={() => setEarnMode("category")} />
              {t("loyalty.stamp.earnByCategory")}
            </label>
          </div>
          {earnMode === "product" ? (
            <Select className="mt-2" value={earnProductId} onChange={(e) => setEarnProductId(e.target.value)}>
              <option value="" disabled>
                —
              </option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {localizedName(p, i18n.language)}
                </option>
              ))}
            </Select>
          ) : (
            <Select className="mt-2" value={earnCategoryId} onChange={(e) => setEarnCategoryId(e.target.value)}>
              <option value="" disabled>
                —
              </option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {localizedName(c, i18n.language)}
                </option>
              ))}
            </Select>
          )}
        </div>
        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            disabled={save.isPending || !rewardProductId || (earnMode === "product" ? !earnProductId : !earnCategoryId)}
            onClick={() => save.mutate()}
          >
            {save.isPending ? <Spinner className="border-primary-foreground" /> : t("common.save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// --- Spend threshold ---------------------------------------------------------

function SpendThresholdSection({ config, branchId }: { config: LoyaltyConfigRow | undefined; branchId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [isEnabled, setIsEnabled] = useState(false);
  const [thresholdAmount, setThresholdAmount] = useState("500");
  const [discountPercent, setDiscountPercent] = useState("10");
  const [resetPeriod, setResetPeriod] = useState<"monthly" | "yearly" | "none">("none");
  const [carryOver, setCarryOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setIsEnabled(config?.isEnabled ?? false);
    const cfg = (config?.config ?? {}) as Record<string, string | boolean>;
    setThresholdAmount(String(cfg.thresholdAmount ?? "500"));
    setDiscountPercent(String(cfg.discountPercent ?? "10"));
    setResetPeriod((cfg.resetPeriod as "monthly" | "yearly" | "none") ?? "none");
    setCarryOver(Boolean(cfg.carryOver));
  }, [config]);

  const save = useMutation({
    mutationFn: () =>
      loyaltyApi.upsertConfig("spend_threshold", {
        branchId: branchId || undefined,
        isEnabled,
        config: { thresholdAmount, discountPercent, resetPeriod, carryOver },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["loyalty-configs"] });
      setError(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t("common.error")),
  });

  return (
    <Card>
      <ProgramHeader type="spend_threshold" config={config} branchId={branchId} />
      <CardContent className="space-y-4">
        {error && <Alert variant="destructive">{error}</Alert>}
        {saved && <Alert>{t("common.saved")}</Alert>}
        <div className="flex items-center gap-2">
          <Switch checked={isEnabled} onCheckedChange={setIsEnabled} aria-label={t("loyalty.enabled")} />
          <span className="text-sm">{t("loyalty.enableThisProgram")}</span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>{t("loyalty.spend.thresholdAmount")}</Label>
            <Input dir="ltr" inputMode="decimal" value={thresholdAmount} onChange={(e) => setThresholdAmount(e.target.value)} />
          </div>
          <div>
            <Label>{t("loyalty.spend.discountPercent")}</Label>
            <Input dir="ltr" inputMode="decimal" value={discountPercent} onChange={(e) => setDiscountPercent(e.target.value)} />
          </div>
          <div>
            <Label>{t("loyalty.spend.resetPeriod")}</Label>
            <Select value={resetPeriod} onChange={(e) => setResetPeriod(e.target.value as typeof resetPeriod)}>
              <option value="none">{t("loyalty.spend.resetNone")}</option>
              <option value="monthly">{t("loyalty.spend.resetMonthly")}</option>
              <option value="yearly">{t("loyalty.spend.resetYearly")}</option>
            </Select>
          </div>
          <div className="flex items-end gap-2 pb-2">
            <Switch checked={carryOver} onCheckedChange={setCarryOver} aria-label={t("loyalty.spend.carryOver")} />
            <span className="text-sm">{t("loyalty.spend.carryOver")}</span>
          </div>
        </div>
        <div className="flex justify-end">
          <Button type="button" size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? <Spinner className="border-primary-foreground" /> : t("common.save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// --- Points per riyal --------------------------------------------------------

function PointsSection({ config, branchId }: { config: LoyaltyConfigRow | undefined; branchId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [isEnabled, setIsEnabled] = useState(false);
  const [pointsPerRiyal, setPointsPerRiyal] = useState("1");
  const [redemptionPointsUnit, setRedemptionPointsUnit] = useState("100");
  const [redemptionSarValue, setRedemptionSarValue] = useState("10");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setIsEnabled(config?.isEnabled ?? false);
    const cfg = (config?.config ?? {}) as Record<string, string>;
    setPointsPerRiyal(cfg.pointsPerRiyal ?? "1");
    setRedemptionPointsUnit(cfg.redemptionPointsUnit ?? "100");
    setRedemptionSarValue(cfg.redemptionSarValue ?? "10");
  }, [config]);

  const save = useMutation({
    mutationFn: () =>
      loyaltyApi.upsertConfig("points_per_riyal", {
        branchId: branchId || undefined,
        isEnabled,
        config: {
          pointsPerRiyal: Number(pointsPerRiyal),
          redemptionPointsUnit: Number(redemptionPointsUnit),
          redemptionSarValue,
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["loyalty-configs"] });
      setError(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t("common.error")),
  });

  return (
    <Card>
      <ProgramHeader type="points_per_riyal" config={config} branchId={branchId} />
      <CardContent className="space-y-4">
        {error && <Alert variant="destructive">{error}</Alert>}
        {saved && <Alert>{t("common.saved")}</Alert>}
        <div className="flex items-center gap-2">
          <Switch checked={isEnabled} onCheckedChange={setIsEnabled} aria-label={t("loyalty.enabled")} />
          <span className="text-sm">{t("loyalty.enableThisProgram")}</span>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label>{t("loyalty.points.pointsPerRiyal")}</Label>
            <Input dir="ltr" inputMode="decimal" value={pointsPerRiyal} onChange={(e) => setPointsPerRiyal(e.target.value)} />
          </div>
          <div>
            <Label>{t("loyalty.points.redemptionPointsUnit")}</Label>
            <Input
              dir="ltr"
              inputMode="numeric"
              value={redemptionPointsUnit}
              onChange={(e) => setRedemptionPointsUnit(e.target.value)}
            />
          </div>
          <div>
            <Label>{t("loyalty.points.redemptionSarValue")}</Label>
            <Input
              dir="ltr"
              inputMode="decimal"
              value={redemptionSarValue}
              onChange={(e) => setRedemptionSarValue(e.target.value)}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("loyalty.points.hint", { unit: redemptionPointsUnit, sar: redemptionSarValue })}
        </p>
        <div className="flex justify-end">
          <Button type="button" size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? <Spinner className="border-primary-foreground" /> : t("common.save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// --- Membership tiers ---------------------------------------------------------

function TierSection({ config, branchId }: { config: LoyaltyConfigRow | undefined; branchId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [isEnabled, setIsEnabled] = useState(false);
  const [tiers, setTiers] = useState<TierRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setIsEnabled(config?.isEnabled ?? false);
    const cfg = (config?.config ?? {}) as { tiers?: TierRow[] };
    setTiers(cfg.tiers ?? []);
  }, [config]);

  const save = useMutation({
    mutationFn: () =>
      loyaltyApi.upsertConfig("tier", {
        branchId: branchId || undefined,
        isEnabled,
        config: { tiers },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["loyalty-configs"] });
      setError(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t("common.error")),
  });

  function addTier() {
    setTiers([...tiers, { key: `tier_${tiers.length + 1}`, nameAr: "", minSpend: "0", discountPercent: "0" }]);
  }
  function updateTier(index: number, patch: Partial<TierRow>) {
    setTiers(tiers.map((tier, i) => (i === index ? { ...tier, ...patch } : tier)));
  }
  function removeTier(index: number) {
    setTiers(tiers.filter((_, i) => i !== index));
  }

  return (
    <Card>
      <ProgramHeader type="tier" config={config} branchId={branchId} />
      <CardContent className="space-y-4">
        {error && <Alert variant="destructive">{error}</Alert>}
        {saved && <Alert>{t("common.saved")}</Alert>}
        <div className="flex items-center gap-2">
          <Switch checked={isEnabled} onCheckedChange={setIsEnabled} aria-label={t("loyalty.enabled")} />
          <span className="text-sm">{t("loyalty.enableThisProgram")}</span>
        </div>
        <div className="space-y-2">
          {tiers.map((tier, index) => (
            <div key={index} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
              <Input
                className="w-32"
                placeholder={t("loyalty.tier.nameAr")}
                value={tier.nameAr}
                onChange={(e) => updateTier(index, { nameAr: e.target.value })}
              />
              <Input
                className="w-28"
                dir="ltr"
                inputMode="decimal"
                placeholder={t("loyalty.tier.minSpend")}
                value={tier.minSpend}
                onChange={(e) => updateTier(index, { minSpend: e.target.value })}
              />
              <Input
                className="w-28"
                dir="ltr"
                inputMode="decimal"
                placeholder={t("loyalty.tier.discountPercent")}
                value={tier.discountPercent}
                onChange={(e) => updateTier(index, { discountPercent: e.target.value })}
              />
              <Button type="button" variant="ghost" size="sm" onClick={() => removeTier(index)}>
                {t("catalog.delete")}
              </Button>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between">
          <Button type="button" variant="outline" size="sm" onClick={addTier}>
            {t("loyalty.tier.addTier")}
          </Button>
          <Button type="button" size="sm" disabled={save.isPending || tiers.length === 0} onClick={() => save.mutate()}>
            {save.isPending ? <Spinner className="border-primary-foreground" /> : t("common.save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
