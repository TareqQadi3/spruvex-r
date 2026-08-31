import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Badge, Button, Card, CardContent, Dialog, Input, Label, Spinner } from "@spruvex-r/ui";

import { ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { purchasesApi, type Supplier } from "../../lib/purchases-api";

interface SupplierForm {
  name: string;
  nameEn: string;
  vatNumber: string;
  contactPhone: string;
  contactEmail: string;
  address: string;
  notes: string;
}

const emptyForm: SupplierForm = {
  name: "",
  nameEn: "",
  vatNumber: "",
  contactPhone: "",
  contactEmail: "",
  address: "",
  notes: "",
};

export function SuppliersPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const canManage = Boolean(user?.permissions.includes("purchases.create"));
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["purchases", "suppliers"],
    queryFn: () => purchasesApi.listSuppliers(true),
  });

  const [editing, setEditing] = useState<Supplier | "new" | null>(null);
  const [form, setForm] = useState<SupplierForm>(emptyForm);
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["purchases", "suppliers"] });

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: form.name,
        ...(form.nameEn ? { nameEn: form.nameEn } : {}),
        ...(form.vatNumber ? { vatNumber: form.vatNumber } : {}),
        ...(form.contactPhone ? { contactPhone: form.contactPhone } : {}),
        ...(form.contactEmail ? { contactEmail: form.contactEmail } : {}),
        ...(form.address ? { address: form.address } : {}),
        ...(form.notes ? { notes: form.notes } : {}),
      };
      if (editing === "new") {
        await purchasesApi.createSupplier(body);
      } else if (editing) {
        await purchasesApi.updateSupplier(editing.id, body);
      }
    },
    onSuccess: async () => {
      await invalidate();
      setEditing(null);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t("common.error")),
  });

  const toggleActive = useMutation({
    mutationFn: (supplier: Supplier) => purchasesApi.updateSupplier(supplier.id, { isActive: !supplier.isActive }),
    onSuccess: invalidate,
    onError: (e) => alert(e instanceof ApiError ? e.message : t("common.error")),
  });

  function openEditor(supplier: Supplier | "new") {
    setError(null);
    setEditing(supplier);
    setForm(
      supplier === "new"
        ? emptyForm
        : {
            name: supplier.name,
            nameEn: supplier.nameEn ?? "",
            vatNumber: supplier.vatNumber ?? "",
            contactPhone: supplier.contactPhone ?? "",
            contactEmail: supplier.contactEmail ?? "",
            address: supplier.address ?? "",
            notes: supplier.notes ?? "",
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
        <h2 className="text-lg font-semibold">{t("purchases.suppliers.title")}</h2>
        {canManage && (
          <Button onClick={() => openEditor("new")}>
            <Plus className="h-4 w-4" /> {t("purchases.suppliers.add")}
          </Button>
        )}
      </div>

      {isLoading && <Spinner />}
      {data?.length === 0 && <p className="text-muted-foreground">{t("purchases.suppliers.empty")}</p>}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {data?.map((supplier) => (
          <Card key={supplier.id} className={supplier.isActive ? undefined : "opacity-60"}>
            <CardContent className="space-y-2 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold">{supplier.name}</p>
                  {supplier.nameEn && (
                    <p className="text-xs text-muted-foreground" dir="ltr">
                      {supplier.nameEn}
                    </p>
                  )}
                </div>
                {!supplier.isActive && <Badge variant="muted">{t("purchases.suppliers.inactive")}</Badge>}
              </div>
              {supplier.vatNumber && (
                <p className="text-xs text-muted-foreground" dir="ltr">
                  {t("purchases.suppliers.vatNumber")}: {supplier.vatNumber}
                </p>
              )}
              {supplier.contactPhone && (
                <p className="text-xs text-muted-foreground" dir="ltr">
                  {supplier.contactPhone}
                </p>
              )}
              {canManage && (
                <div className="flex justify-end gap-1 pt-1">
                  <Button variant="ghost" size="icon" aria-label={t("catalog.edit")} onClick={() => openEditor(supplier)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => toggleActive.mutate(supplier)}
                  >
                    {supplier.isActive ? t("purchases.suppliers.deactivate") : t("purchases.suppliers.activate")}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === "new" ? t("purchases.suppliers.add") : t("purchases.suppliers.editTitle")}
      >
        <form onSubmit={submit} className="space-y-4">
          {error && <Alert variant="destructive">{error}</Alert>}
          <div className="space-y-2">
            <Label htmlFor="sname">{t("catalog.nameAr")}</Label>
            <Input id="sname" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="snameEn">{t("catalog.nameEn")}</Label>
            <Input id="snameEn" dir="ltr" value={form.nameEn} onChange={(e) => setForm({ ...form, nameEn: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="svat">{t("purchases.suppliers.vatNumber")}</Label>
            <Input
              id="svat"
              dir="ltr"
              placeholder={t("purchases.suppliers.vatNumberPlaceholder")}
              value={form.vatNumber}
              onChange={(e) => setForm({ ...form, vatNumber: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="sphone">{t("purchases.suppliers.contactPhone")}</Label>
              <Input
                id="sphone"
                dir="ltr"
                value={form.contactPhone}
                onChange={(e) => setForm({ ...form, contactPhone: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="semail">{t("purchases.suppliers.contactEmail")}</Label>
              <Input
                id="semail"
                dir="ltr"
                type="email"
                value={form.contactEmail}
                onChange={(e) => setForm({ ...form, contactEmail: e.target.value })}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="saddress">{t("purchases.suppliers.address")}</Label>
            <Input id="saddress" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
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
