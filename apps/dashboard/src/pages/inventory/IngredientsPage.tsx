import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  Input,
  Label,
  Select,
  Spinner,
} from "@spruvex-r/ui";

import { ApiError } from "../../lib/api";
import { localizedName } from "../../lib/catalog-api";
import { inventoryApi, type Ingredient, type UnitType } from "../../lib/inventory-api";

interface IngredientForm {
  name: string;
  nameEn: string;
  unitType: UnitType;
  reorderLevel: string;
}

const emptyForm: IngredientForm = { name: "", nameEn: "", unitType: "mass", reorderLevel: "" };

export function IngredientsPage() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["inventory", "ingredients"],
    queryFn: inventoryApi.listIngredients,
  });

  const [editing, setEditing] = useState<Ingredient | "new" | null>(null);
  const [form, setForm] = useState<IngredientForm>(emptyForm);
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["inventory"] });

  const save = useMutation({
    mutationFn: async () => {
      if (editing === "new") {
        await inventoryApi.createIngredient({
          name: form.name,
          ...(form.nameEn ? { nameEn: form.nameEn } : {}),
          unitType: form.unitType,
          ...(form.reorderLevel ? { reorderLevel: form.reorderLevel } : {}),
        });
      } else if (editing) {
        await inventoryApi.updateIngredient(editing.id, {
          name: form.name,
          ...(form.nameEn ? { nameEn: form.nameEn } : {}),
          reorderLevel: form.reorderLevel || null,
        });
      }
    },
    onSuccess: async () => {
      await invalidate();
      setEditing(null);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t("common.error")),
  });

  const remove = useMutation({
    mutationFn: (id: string) => inventoryApi.deleteIngredient(id),
    onSuccess: invalidate,
    onError: (e) => alert(e instanceof ApiError ? e.message : t("common.error")),
  });

  function openEditor(ingredient: Ingredient | "new") {
    setError(null);
    setEditing(ingredient);
    setForm(
      ingredient === "new"
        ? emptyForm
        : {
            name: ingredient.name,
            nameEn: ingredient.nameEn ?? "",
            unitType: ingredient.unitType,
            reorderLevel: ingredient.reorderLevel ?? "",
          },
    );
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("inventory.ingredients.title")}</h2>
        <Button onClick={() => openEditor("new")}>
          <Plus className="h-4 w-4" /> {t("inventory.ingredients.add")}
        </Button>
      </div>

      {isLoading && <Spinner />}
      {data?.length === 0 && <p className="text-muted-foreground">{t("inventory.ingredients.empty")}</p>}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {data?.map((ingredient) => {
          return (
            <Card key={ingredient.id}>
              <CardContent className="flex items-start justify-between gap-3 p-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{localizedName(ingredient, i18n.language)}</span>
                    <Badge variant="muted">{t(`inventory.unitTypes.${ingredient.unitType}`)}</Badge>
                  </div>
                  {ingredient.nameEn && (
                    <p className="text-xs text-muted-foreground" dir="ltr">
                      {ingredient.nameEn}
                    </p>
                  )}
                  <p className="mt-1 text-xs text-muted-foreground" dir="ltr">
                    {t("inventory.ingredients.avgCost")}: {ingredient.averageCost} SAR
                    {ingredient.reorderLevel && ` · ${t("inventory.ingredients.reorderLevel")}: ${ingredient.reorderLevel}`}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    title={t("catalog.edit")}
                    aria-label={t("catalog.edit")}
                    onClick={() => openEditor(ingredient)}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    title={t("catalog.delete")}
                    aria-label={t("catalog.delete")}
                    onClick={() => {
                      if (confirm(t("catalog.confirmDelete"))) remove.mutate(ingredient.id);
                    }}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === "new" ? t("inventory.ingredients.add") : t("inventory.ingredients.editTitle")}
      >
        <form onSubmit={submit} className="space-y-4">
          {error && <Alert variant="destructive">{error}</Alert>}
          <div className="space-y-2">
            <Label htmlFor="iname">{t("catalog.nameAr")}</Label>
            <Input
              id="iname"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="inameEn">{t("catalog.nameEn")}</Label>
            <Input
              id="inameEn"
              dir="ltr"
              value={form.nameEn}
              onChange={(e) => setForm({ ...form, nameEn: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="iunit">{t("inventory.ingredients.unitType")}</Label>
              <Select
                id="iunit"
                disabled={editing !== "new"}
                value={form.unitType}
                onChange={(e) => setForm({ ...form, unitType: e.target.value as UnitType })}
              >
                <option value="mass">{t("inventory.unitTypes.mass")}</option>
                <option value="volume">{t("inventory.unitTypes.volume")}</option>
                <option value="count">{t("inventory.unitTypes.count")}</option>
              </Select>
              {editing !== "new" && (
                <p className="text-xs text-muted-foreground">{t("inventory.ingredients.unitTypeLocked")}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="ireorder">{t("inventory.ingredients.reorderLevel")}</Label>
              <Input
                id="ireorder"
                dir="ltr"
                inputMode="decimal"
                placeholder="0"
                value={form.reorderLevel}
                onChange={(e) => setForm({ ...form, reorderLevel: e.target.value })}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setEditing(null)}>
              {t("catalog.cancel")}
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? <Spinner className="border-primary-foreground" /> : t("common.save")}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
