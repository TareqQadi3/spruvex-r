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
  ImageInput,
  Input,
  Label,
  Spinner,
  Switch,
  Textarea,
} from "@spruvex-r/ui";

import { ApiError, uploadImage } from "../../lib/api";
import { catalogApi, localizedName, type Category } from "../../lib/catalog-api";

interface CategoryForm {
  name: string;
  nameEn: string;
  description: string;
  imageUrl: string;
  sortOrder: number;
  isActive: boolean;
}

const emptyForm: CategoryForm = {
  name: "",
  nameEn: "",
  description: "",
  imageUrl: "",
  sortOrder: 0,
  isActive: true,
};

export function CategoriesPage() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["catalog", "categories"],
    queryFn: catalogApi.listCategories,
  });

  const [editing, setEditing] = useState<Category | "new" | null>(null);
  const [form, setForm] = useState<CategoryForm>(emptyForm);
  const [error, setError] = useState<string | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["catalog", "categories"] });

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: form.name,
        ...(form.nameEn ? { nameEn: form.nameEn } : {}),
        ...(form.description ? { description: form.description } : {}),
        ...(form.imageUrl ? { imageUrl: form.imageUrl } : {}),
        sortOrder: form.sortOrder,
        isActive: form.isActive,
      };
      if (editing === "new") {
        await catalogApi.createCategory(body);
      } else if (editing) {
        await catalogApi.updateCategory(editing.id, body);
      }
    },
    onSuccess: async () => {
      await invalidate();
      setEditing(null);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t("common.error")),
  });

  const remove = useMutation({
    mutationFn: (id: string) => catalogApi.deleteCategory(id),
    onSuccess: invalidate,
    onError: (e) => alert(e instanceof ApiError ? e.message : t("common.error")),
  });

  const toggleActive = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      catalogApi.updateCategory(id, { isActive }),
    onSuccess: invalidate,
  });

  function openEditor(category: Category | "new") {
    setError(null);
    setEditing(category);
    setForm(
      category === "new"
        ? { ...emptyForm, sortOrder: data?.length ?? 0 }
        : {
            name: category.name,
            nameEn: category.nameEn ?? "",
            description: category.description ?? "",
            imageUrl: category.imageUrl ?? "",
            sortOrder: category.sortOrder,
            isActive: category.isActive,
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
        <h2 className="text-lg font-semibold">{t("catalog.categories.title")}</h2>
        <Button onClick={() => openEditor("new")}>
          <Plus className="h-4 w-4" /> {t("catalog.categories.add")}
        </Button>
      </div>

      {isLoading && <Spinner />}
      {data?.length === 0 && (
        <p className="text-muted-foreground">{t("catalog.categories.empty")}</p>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {data?.map((category) => (
          <Card key={category.id}>
            <CardContent className="flex items-start justify-between gap-3 p-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{localizedName(category, i18n.language)}</span>
                  <Badge variant={category.isActive ? "success" : "muted"}>
                    {category.isActive ? t("catalog.active") : t("catalog.inactive")}
                  </Badge>
                </div>
                {category.nameEn && (
                  <p className="text-xs text-muted-foreground" dir="ltr">
                    {category.nameEn}
                  </p>
                )}
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("catalog.categories.productsCount", {
                    count: category._count?.products ?? 0,
                  })}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Switch
                  checked={category.isActive}
                  aria-label={t("catalog.active")}
                  onCheckedChange={(isActive) =>
                    toggleActive.mutate({ id: category.id, isActive })
                  }
                />
                <Button
                  variant="ghost"
                  size="icon"
                  title={t("catalog.edit")}
                  aria-label={t("catalog.edit")}
                  onClick={() => openEditor(category)}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  title={t("catalog.delete")}
                  aria-label={t("catalog.delete")}
                  onClick={() => {
                    if (confirm(t("catalog.confirmDelete"))) remove.mutate(category.id);
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
        title={
          editing === "new" ? t("catalog.categories.add") : t("catalog.categories.editTitle")
        }
      >
        <form onSubmit={submit} className="space-y-4">
          {error && <Alert variant="destructive">{error}</Alert>}
          <div className="space-y-2">
            <Label htmlFor="cname">{t("catalog.nameAr")}</Label>
            <Input
              id="cname"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cnameEn">{t("catalog.nameEn")}</Label>
            <Input
              id="cnameEn"
              dir="ltr"
              value={form.nameEn}
              onChange={(e) => setForm({ ...form, nameEn: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cdesc">{t("catalog.descriptionAr")}</Label>
            <Textarea
              id="cdesc"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
          <ImageInput
            label={t("catalog.imageUrl")}
            value={form.imageUrl}
            onChange={(imageUrl) => setForm({ ...form, imageUrl })}
            onUploadFile={uploadImage}
            uploadTabLabel={t("common.uploadTab")}
            urlTabLabel={t("common.urlTab")}
            uploadButtonLabel={t("common.uploadButton")}
            removeLabel={t("common.removeImage")}
            errorFallback={t("common.uploadError")}
            constraintsHint={t("common.imageConstraints")}
          />
          <div className="space-y-2">
            <Label htmlFor="csort">{t("catalog.sortOrder")}</Label>
            <Input
              id="csort"
              type="number"
              min={0}
              value={form.sortOrder}
              onChange={(e) => setForm({ ...form, sortOrder: Number(e.target.value) })}
            />
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
