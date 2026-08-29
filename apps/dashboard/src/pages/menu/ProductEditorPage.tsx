import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";

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

import { api } from "../../lib/api";
import { ApiError } from "../../lib/api";
import { catalogApi, localizedName, type Product } from "../../lib/catalog-api";
import { inventoryApi, type RecipeItemRow } from "../../lib/inventory-api";

interface BranchRow {
  id: string;
  name: string;
  nameEn: string | null;
}

interface ProductForm {
  name: string;
  nameEn: string;
  description: string;
  descriptionEn: string;
  imageUrl: string;
  sku: string;
  categoryId: string;
  basePrice: string;
  taxRate: string;
  sortOrder: number;
  isActive: boolean;
}

const emptyForm: ProductForm = {
  name: "",
  nameEn: "",
  description: "",
  descriptionEn: "",
  imageUrl: "",
  sku: "",
  categoryId: "",
  basePrice: "",
  taxRate: "",
  sortOrder: 0,
  isActive: true,
};

export function ProductEditorPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { id } = useParams();
  const isNew = id === undefined;

  const categories = useQuery({
    queryKey: ["catalog", "categories"],
    queryFn: catalogApi.listCategories,
  });
  const groups = useQuery({
    queryKey: ["catalog", "modifier-groups"],
    queryFn: catalogApi.listModifierGroups,
  });
  const branches = useQuery({
    queryKey: ["branches"],
    queryFn: () => api<BranchRow[]>("/branches"),
  });
  const product = useQuery({
    queryKey: ["catalog", "product", id],
    queryFn: () => catalogApi.getProduct(id!),
    enabled: !isNew,
  });

  const [form, setForm] = useState<ProductForm>(emptyForm);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (product.data) {
      const p = product.data;
      setForm({
        name: p.name,
        nameEn: p.nameEn ?? "",
        description: p.description ?? "",
        descriptionEn: p.descriptionEn ?? "",
        imageUrl: p.imageUrl ?? "",
        sku: p.sku ?? "",
        categoryId: p.categoryId,
        basePrice: p.basePrice,
        taxRate: p.taxRate ?? "",
        sortOrder: p.sortOrder,
        isActive: p.isActive,
      });
    }
  }, [product.data]);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["catalog"] });

  const save = useMutation({
    mutationFn: async (): Promise<Product> => {
      const body = {
        name: form.name,
        ...(form.nameEn ? { nameEn: form.nameEn } : {}),
        ...(form.description ? { description: form.description } : {}),
        ...(form.descriptionEn ? { descriptionEn: form.descriptionEn } : {}),
        ...(form.imageUrl ? { imageUrl: form.imageUrl } : {}),
        ...(form.sku ? { sku: form.sku } : {}),
        categoryId: form.categoryId,
        basePrice: form.basePrice,
        ...(form.taxRate ? { taxRate: form.taxRate } : {}),
        sortOrder: form.sortOrder,
        isActive: form.isActive,
      };
      return isNew ? catalogApi.createProduct(body) : catalogApi.updateProduct(id!, body);
    },
    onSuccess: async (saved) => {
      await invalidate();
      if (isNew) {
        navigate(`/menu/products/${saved.id}`, { replace: true });
      }
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t("common.error")),
  });

  const setGroups = useMutation({
    mutationFn: (groupIds: string[]) =>
      catalogApi.setProductModifierGroups(
        id!,
        groupIds.map((modifierGroupId, index) => ({ modifierGroupId, sortOrder: index })),
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["catalog", "product", id] }),
    onError: (e) => alert(e instanceof ApiError ? e.message : t("common.error")),
  });

  const setBranchSetting = useMutation({
    mutationFn: (input: { branchId: string; isAvailable: boolean; priceOverride?: string | null }) =>
      catalogApi.setBranchSetting(id!, input.branchId, {
        isAvailable: input.isAvailable,
        priceOverride: input.priceOverride ?? null,
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["catalog", "product", id] }),
    onError: (e) => alert(e instanceof ApiError ? e.message : t("common.error")),
  });

  // Local state for branch price override inputs (committed on blur/save click).
  const [overrideDrafts, setOverrideDrafts] = useState<Record<string, string>>({});

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    save.mutate();
  }

  const attachedGroupIds = new Set(
    product.data?.modifierGroups.map((g) => g.modifierGroupId) ?? [],
  );

  if (!isNew && product.isLoading) {
    return <Spinner />;
  }

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold">
        {isNew ? t("catalog.products.add") : t("catalog.products.editTitle")}
      </h2>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("catalog.products.details")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            {error && <Alert variant="destructive">{error}</Alert>}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="pname">{t("catalog.nameAr")}</Label>
                <Input
                  id="pname"
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pnameEn">{t("catalog.nameEn")}</Label>
                <Input
                  id="pnameEn"
                  dir="ltr"
                  value={form.nameEn}
                  onChange={(e) => setForm({ ...form, nameEn: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pdesc">{t("catalog.descriptionAr")}</Label>
                <Textarea
                  id="pdesc"
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pdescEn">{t("catalog.descriptionEn")}</Label>
                <Textarea
                  id="pdescEn"
                  dir="ltr"
                  value={form.descriptionEn}
                  onChange={(e) => setForm({ ...form, descriptionEn: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pcat">{t("catalog.products.category")}</Label>
                <Select
                  id="pcat"
                  required
                  value={form.categoryId}
                  onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
                >
                  <option value="" disabled>
                    —
                  </option>
                  {categories.data?.map((category) => (
                    <option key={category.id} value={category.id}>
                      {localizedName(category, i18n.language)}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="psku">{t("catalog.products.sku")}</Label>
                <Input
                  id="psku"
                  dir="ltr"
                  value={form.sku}
                  onChange={(e) => setForm({ ...form, sku: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pprice">{t("catalog.products.basePrice")} (SAR)</Label>
                <Input
                  id="pprice"
                  dir="ltr"
                  required
                  inputMode="decimal"
                  placeholder="25.00"
                  value={form.basePrice}
                  onChange={(e) => setForm({ ...form, basePrice: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ptax">{t("catalog.products.taxRate")}</Label>
                <Input
                  id="ptax"
                  dir="ltr"
                  inputMode="decimal"
                  placeholder={t("catalog.products.taxDefault")}
                  value={form.taxRate}
                  onChange={(e) => setForm({ ...form, taxRate: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pimg">{t("catalog.imageUrl")}</Label>
                <Input
                  id="pimg"
                  dir="ltr"
                  type="url"
                  value={form.imageUrl}
                  onChange={(e) => setForm({ ...form, imageUrl: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="psort">{t("catalog.sortOrder")}</Label>
                <Input
                  id="psort"
                  type="number"
                  min={0}
                  value={form.sortOrder}
                  onChange={(e) => setForm({ ...form, sortOrder: Number(e.target.value) })}
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                checked={form.isActive}
                aria-label={t("catalog.active")}
                onCheckedChange={(isActive) => setForm({ ...form, isActive })}
              />
              <span className="text-sm">{t("catalog.active")}</span>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => navigate("/menu/products")}>
                {t("common.back")}
              </Button>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? (
                  <Spinner className="border-primary-foreground" />
                ) : (
                  t("common.save")
                )}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {isNew ? (
        <p className="text-sm text-muted-foreground">{t("catalog.products.saveFirst")}</p>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("catalog.products.modifierGroups")}</CardTitle>
              <CardDescription>{t("catalog.products.modifierGroupsHint")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {groups.data?.length === 0 && (
                <p className="text-sm text-muted-foreground">{t("catalog.products.noGroups")}</p>
              )}
              {groups.data?.map((group) => {
                const attached = attachedGroupIds.has(group.id);
                return (
                  <label
                    key={group.id}
                    className="flex cursor-pointer items-center justify-between rounded-md border p-3 hover:bg-muted/40"
                  >
                    <div>
                      <span className="font-medium">{localizedName(group, i18n.language)}</span>
                      <span className="ms-2 text-xs text-muted-foreground">
                        {group.isRequired
                          ? t("catalog.modifiers.required")
                          : t("catalog.modifiers.optional")}
                        {" · "}
                        {t("catalog.modifiers.optionsCount", { count: group.modifiers.length })}
                      </span>
                    </div>
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[hsl(var(--primary))]"
                      checked={attached}
                      disabled={setGroups.isPending}
                      onChange={(e) => {
                        const next = new Set(attachedGroupIds);
                        if (e.target.checked) {
                          next.add(group.id);
                        } else {
                          next.delete(group.id);
                        }
                        setGroups.mutate([...next]);
                      }}
                    />
                  </label>
                );
              })}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("catalog.products.branchSettings")}</CardTitle>
              <CardDescription>{t("catalog.products.branchSettingsHint")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {branches.data?.map((branch) => {
                const setting = product.data?.branchSettings.find(
                  (s) => s.branchId === branch.id,
                );
                const isAvailable = setting?.isAvailable ?? true;
                const draft =
                  overrideDrafts[branch.id] ?? setting?.priceOverride ?? "";
                return (
                  <div
                    key={branch.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
                  >
                    <span className="font-medium">
                      {localizedName(
                        { name: branch.name, nameEn: branch.nameEn },
                        i18n.language,
                      )}
                    </span>
                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-2">
                        <Input
                          className="w-28"
                          dir="ltr"
                          inputMode="decimal"
                          placeholder={t("catalog.products.basePriceApplies")}
                          value={draft}
                          onChange={(e) =>
                            setOverrideDrafts({ ...overrideDrafts, [branch.id]: e.target.value })
                          }
                          onBlur={() => {
                            const value = overrideDrafts[branch.id];
                            if (value === undefined) return;
                            setBranchSetting.mutate({
                              branchId: branch.id,
                              isAvailable,
                              priceOverride: value === "" ? null : value,
                            });
                          }}
                        />
                        <span className="text-xs text-muted-foreground">
                          {t("catalog.products.priceOverride")}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={isAvailable}
                          disabled={setBranchSetting.isPending}
                          aria-label={t("catalog.products.availableInBranch")}
                          onCheckedChange={(next) =>
                            setBranchSetting.mutate({
                              branchId: branch.id,
                              isAvailable: next,
                              priceOverride: setting?.priceOverride ?? null,
                            })
                          }
                        />
                        <span className="text-sm">{t("catalog.products.availableInBranch")}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>

          <RecipeEditor productId={id!} />
        </>
      )}
    </div>
  );
}

interface RecipeRow {
  ingredientId: string;
  unitId: string;
  quantity: string;
}

/** Food-cost recipe editor (Phase 7) — full-replace list of ingredient lines + live cost/margin preview. */
function RecipeEditor({ productId }: { productId: string }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();

  const ingredients = useQuery({
    queryKey: ["inventory", "ingredients"],
    queryFn: inventoryApi.listIngredients,
  });
  const units = useQuery({ queryKey: ["inventory", "units"], queryFn: inventoryApi.listUnits });
  const recipe = useQuery({
    queryKey: ["inventory", "recipe", productId],
    queryFn: () => inventoryApi.getRecipe(productId),
  });
  const cost = useQuery({
    queryKey: ["inventory", "recipe-cost", productId],
    queryFn: () => inventoryApi.getProductCost(productId),
  });

  const [rows, setRows] = useState<RecipeRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (recipe.data) {
      setRows(
        recipe.data.items.map((item: RecipeItemRow) => ({
          ingredientId: item.ingredientId,
          unitId: item.unitId,
          quantity: item.quantity,
        })),
      );
    }
  }, [recipe.data]);

  const save = useMutation({
    mutationFn: () =>
      inventoryApi.setRecipe(
        productId,
        rows.filter((row) => row.ingredientId && row.unitId && row.quantity),
      ),
    onSuccess: async () => {
      setError(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["inventory", "recipe", productId] }),
        queryClient.invalidateQueries({ queryKey: ["inventory", "recipe-cost", productId] }),
      ]);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t("common.error")),
  });

  function addRow() {
    const firstIngredient = ingredients.data?.[0];
    const firstUnit = units.data?.find((u) => u.type === firstIngredient?.unitType);
    setRows([...rows, { ingredientId: firstIngredient?.id ?? "", unitId: firstUnit?.id ?? "", quantity: "" }]);
  }

  function updateRow(index: number, patch: Partial<RecipeRow>) {
    setRows(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function removeRow(index: number) {
    setRows(rows.filter((_, i) => i !== index));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("inventory.recipe.title")}</CardTitle>
        <CardDescription>{t("inventory.recipe.hint")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <Alert variant="destructive">{error}</Alert>}

        {cost.data && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm">
            <Badge variant={cost.data.hasRecipe ? "success" : "muted"}>
              {cost.data.hasRecipe ? t("inventory.recipe.costed") : t("inventory.recipe.noRecipe")}
            </Badge>
            <span dir="ltr">
              {t("inventory.recipe.cost")}: {cost.data.cost} SAR
            </span>
            <span dir="ltr">
              {t("inventory.recipe.margin")}: {cost.data.grossMargin} SAR ({cost.data.grossMarginPercent}%)
            </span>
          </div>
        )}

        <div className="space-y-2">
          {rows.map((row, index) => {
            const selectedIngredient = ingredients.data?.find((i) => i.id === row.ingredientId);
            const compatibleUnits = units.data?.filter((u) => u.type === selectedIngredient?.unitType) ?? [];
            return (
              <div key={index} className="flex flex-wrap items-center gap-2">
                <Select
                  className="w-48"
                  value={row.ingredientId}
                  onChange={(e) => {
                    const ingredient = ingredients.data?.find((i) => i.id === e.target.value);
                    const compatible = units.data?.find((u) => u.type === ingredient?.unitType);
                    updateRow(index, { ingredientId: e.target.value, unitId: compatible?.id ?? "" });
                  }}
                >
                  <option value="" disabled>
                    —
                  </option>
                  {ingredients.data?.map((ingredient) => (
                    <option key={ingredient.id} value={ingredient.id}>
                      {localizedName(ingredient, i18n.language)}
                    </option>
                  ))}
                </Select>
                <Input
                  className="w-28"
                  dir="ltr"
                  inputMode="decimal"
                  placeholder={t("inventory.recipe.quantity")}
                  value={row.quantity}
                  onChange={(e) => updateRow(index, { quantity: e.target.value })}
                />
                <Select
                  className="w-32"
                  value={row.unitId}
                  onChange={(e) => updateRow(index, { unitId: e.target.value })}
                >
                  <option value="" disabled>
                    —
                  </option>
                  {compatibleUnits.map((unit) => (
                    <option key={unit.id} value={unit.id}>
                      {localizedName(unit, i18n.language)}
                    </option>
                  ))}
                </Select>
                <Button
                  variant="ghost"
                  size="icon"
                  title={t("catalog.delete")}
                  aria-label={t("catalog.delete")}
                  onClick={() => removeRow(index)}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between">
          <Button type="button" variant="outline" size="sm" onClick={addRow}>
            <Plus className="h-4 w-4" /> {t("inventory.recipe.addIngredient")}
          </Button>
          <Button type="button" size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? <Spinner className="border-primary-foreground" /> : t("common.save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
