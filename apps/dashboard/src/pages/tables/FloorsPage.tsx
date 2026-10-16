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
  Switch,
} from "@spruvex-r/ui";

import { api, ApiError } from "../../lib/api";
import { localizedName } from "../../lib/catalog-api";
import { tablesApi, type Floor } from "../../lib/tables-api";

interface BranchRow {
  id: string;
  name: string;
  nameEn: string | null;
}

interface FloorForm {
  branchId: string;
  name: string;
  nameEn: string;
  sortOrder: number;
  isActive: boolean;
}

export function FloorsPage() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();

  const branches = useQuery({ queryKey: ["branches"], queryFn: () => api<BranchRow[]>("/branches") });
  const floors = useQuery({ queryKey: ["floors"], queryFn: () => tablesApi.listFloors() });

  const [editing, setEditing] = useState<Floor | "new" | null>(null);
  const [form, setForm] = useState<FloorForm>({
    branchId: "",
    name: "",
    nameEn: "",
    sortOrder: 0,
    isActive: true,
  });
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["floors"] });

  const save = useMutation({
    mutationFn: async () => {
      const base = {
        name: form.name,
        ...(form.nameEn ? { nameEn: form.nameEn } : {}),
        sortOrder: form.sortOrder,
        isActive: form.isActive,
      };
      if (editing === "new") {
        await tablesApi.createFloor({ ...base, branchId: form.branchId });
      } else if (editing) {
        await tablesApi.updateFloor(editing.id, base);
      }
    },
    onSuccess: async () => {
      await invalidate();
      setEditing(null);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t("common.error")),
  });

  const remove = useMutation({
    mutationFn: (id: string) => tablesApi.deleteFloor(id),
    onSuccess: invalidate,
    onError: (e) => alert(e instanceof ApiError ? e.message : t("common.error")),
  });

  function openEditor(floor: Floor | "new") {
    setError(null);
    setEditing(floor);
    setForm(
      floor === "new"
        ? {
            branchId: branches.data?.[0]?.id ?? "",
            name: "",
            nameEn: "",
            sortOrder: floors.data?.length ?? 0,
            isActive: true,
          }
        : {
            branchId: floor.branchId,
            name: floor.name,
            nameEn: floor.nameEn ?? "",
            sortOrder: floor.sortOrder,
            isActive: floor.isActive,
          },
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("tables.floors.title")}</h2>
        <Button onClick={() => openEditor("new")}>
          <Plus className="h-4 w-4" /> {t("tables.floors.add")}
        </Button>
      </div>

      {floors.isLoading && <Spinner />}
      {floors.data?.length === 0 && (
        <p className="text-muted-foreground">{t("tables.floors.empty")}</p>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {floors.data?.map((floor) => (
          <Card key={floor.id}>
            <CardContent className="flex items-start justify-between gap-3 p-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{localizedName(floor, i18n.language)}</span>
                  <Badge variant={floor.isActive ? "success" : "muted"}>
                    {floor.isActive ? t("catalog.active") : t("catalog.inactive")}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("tables.floors.branch")}: {localizedName(floor.branch, i18n.language)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("tables.floors.tablesCount", { count: floor._count?.tables ?? 0 })}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  title={t("catalog.edit")}
                  aria-label={t("catalog.edit")}
                  onClick={() => openEditor(floor)}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  title={t("catalog.delete")}
                  aria-label={t("catalog.delete")}
                  onClick={() => {
                    if (confirm(t("catalog.confirmDelete"))) remove.mutate(floor.id);
                  }}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === "new" ? t("tables.floors.add") : t("tables.floors.editTitle")}
      >
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            save.mutate();
          }}
          className="space-y-4"
        >
          {error && <Alert variant="destructive">{error}</Alert>}
          {editing === "new" && (
            <div className="space-y-2">
              <Label htmlFor="fbranch">{t("tables.floors.branch")}</Label>
              <Select
                id="fbranch"
                required
                value={form.branchId}
                onChange={(e) => setForm({ ...form, branchId: e.target.value })}
              >
                {branches.data?.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {localizedName(branch, i18n.language)}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="fname">{t("catalog.nameAr")}</Label>
            <Input
              id="fname"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="fnameEn">{t("catalog.nameEn")}</Label>
            <Input
              id="fnameEn"
              dir="ltr"
              value={form.nameEn}
              onChange={(e) => setForm({ ...form, nameEn: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="fsort">{t("catalog.sortOrder")}</Label>
              <Input
                id="fsort"
                type="number"
                min={0}
                value={form.sortOrder}
                onChange={(e) => setForm({ ...form, sortOrder: Number(e.target.value) })}
              />
            </div>
            <div className="flex items-end gap-2 pb-2">
              <Switch
                checked={form.isActive}
                aria-label={t("catalog.active")}
                onCheckedChange={(isActive) => setForm({ ...form, isActive })}
              />
              <span className="text-sm">{t("catalog.active")}</span>
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
