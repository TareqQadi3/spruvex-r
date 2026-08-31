import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Badge, Button, Card, CardContent, Dialog, Input, Label, Select, Spinner } from "@spruvex-r/ui";

import { api, ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { localizedName } from "../../lib/catalog-api";
import { inventoryApi, type ReorderAlertRow } from "../../lib/inventory-api";
import { purchasesApi, type PurchaseInvoiceItemInput, type Supplier } from "../../lib/purchases-api";

interface BranchRow {
  id: string;
  name: string;
  nameEn: string | null;
}

export function ReorderAlertsPage() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const canCreateInvoice = Boolean(user?.permissions.includes("purchases.create"));
  const queryClient = useQueryClient();

  const branches = useQuery({ queryKey: ["branches"], queryFn: () => api<BranchRow[]>("/branches") });
  const [branchId, setBranchId] = useState("");
  const activeBranchId = branchId || branches.data?.[0]?.id || "";

  const alerts = useQuery({
    queryKey: ["inventory", "reorder-alerts", activeBranchId],
    queryFn: () => inventoryApi.listReorderAlerts(activeBranchId),
    enabled: Boolean(activeBranchId),
  });

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);

  function toggleSelected(row: ReorderAlertRow) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(row.ingredientId)) {
        next.delete(row.ingredientId);
      } else {
        next.add(row.ingredientId);
        if (!(row.ingredientId in quantities)) {
          setQuantities((q) => ({ ...q, [row.ingredientId]: row.suggestedQuantity }));
        }
      }
      return next;
    });
  }

  const selectedRows = (alerts.data ?? []).filter((r) => selected.has(r.ingredientId));

  function openCreateDialog() {
    setCreating(true);
  }

  function closeCreateDialog() {
    setCreating(false);
  }

  function afterCreated() {
    setCreating(false);
    setSelected(new Set());
    setQuantities({});
    void queryClient.invalidateQueries({ queryKey: ["inventory", "reorder-alerts"] });
    void queryClient.invalidateQueries({ queryKey: ["purchases"] });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Select className="w-48" value={activeBranchId} onChange={(e) => setBranchId(e.target.value)}>
          {branches.data?.map((b) => (
            <option key={b.id} value={b.id}>
              {localizedName({ name: b.name, nameEn: b.nameEn }, i18n.language)}
            </option>
          ))}
        </Select>
        {canCreateInvoice && (
          <Button onClick={openCreateDialog} disabled={selected.size === 0}>
            {t("inventory.reorderAlerts.createDraftInvoice", { count: selected.size })}
          </Button>
        )}
      </div>

      {alerts.isLoading && <Spinner />}
      {alerts.data?.length === 0 && <p className="text-muted-foreground">{t("inventory.reorderAlerts.empty")}</p>}

      <Card>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
              <tr>
                {canCreateInvoice && <th className="w-10 p-3" />}
                <th className="p-3 text-start">{t("inventory.reorderAlerts.ingredient")}</th>
                <th className="p-3 text-start">{t("inventory.reorderAlerts.currentQuantity")}</th>
                <th className="p-3 text-start">{t("inventory.ingredients.reorderLevel")}</th>
                <th className="p-3 text-start">{t("inventory.reorderAlerts.lastSupplier")}</th>
                <th className="p-3 text-start">{t("inventory.reorderAlerts.suggestedQuantity")}</th>
              </tr>
            </thead>
            <tbody>
              {alerts.data?.map((row) => {
                const ratio = Number(row.reorderLevel) > 0 ? Number(row.currentQuantity) / Number(row.reorderLevel) : 0;
                const isVeryCritical = ratio <= 0.25;
                return (
                  <tr key={`${row.ingredientId}-${row.locationId}`} className="border-b last:border-0">
                    {canCreateInvoice && (
                      <td className="p-3">
                        <input
                          type="checkbox"
                          checked={selected.has(row.ingredientId)}
                          onChange={() => toggleSelected(row)}
                        />
                      </td>
                    )}
                    <td className="p-3">
                      {localizedName({ name: row.ingredientName, nameEn: row.ingredientNameEn }, i18n.language)}
                      <span className="ms-2 text-xs text-muted-foreground">
                        {localizedName({ name: row.locationName, nameEn: row.locationNameEn }, i18n.language)}
                      </span>
                      {isVeryCritical && (
                        <Badge variant="destructive" className="ms-2">
                          {t("inventory.reorderAlerts.critical")}
                        </Badge>
                      )}
                    </td>
                    <td className="p-3" dir="ltr">
                      {row.currentQuantity}
                    </td>
                    <td className="p-3 text-muted-foreground" dir="ltr">
                      {row.reorderLevel}
                    </td>
                    <td className="p-3">
                      {row.lastSupplier ? (
                        <span>
                          {localizedName({ name: row.lastSupplier.name, nameEn: row.lastSupplier.nameEn }, i18n.language)}
                          <span className="ms-2 text-xs text-muted-foreground" dir="ltr">
                            {row.lastSupplier.lastUnitPrice} SAR · {row.lastSupplier.lastPurchasedAt}
                          </span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground">{t("inventory.reorderAlerts.neverPurchased")}</span>
                      )}
                    </td>
                    <td className="p-3" dir="ltr">
                      {row.suggestedQuantity}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {creating && (
        <CreateReorderInvoiceDialog
          branchId={activeBranchId}
          rows={selectedRows}
          quantities={quantities}
          onQuantityChange={(id, value) => setQuantities((q) => ({ ...q, [id]: value }))}
          onClose={closeCreateDialog}
          onCreated={afterCreated}
        />
      )}
    </div>
  );
}

function CreateReorderInvoiceDialog({
  branchId,
  rows,
  quantities,
  onQuantityChange,
  onClose,
  onCreated,
}: {
  branchId: string;
  rows: ReorderAlertRow[];
  quantities: Record<string, string>;
  onQuantityChange: (ingredientId: string, value: string) => void;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t, i18n } = useTranslation();
  const suppliers = useQuery({ queryKey: ["purchases", "suppliers"], queryFn: () => purchasesApi.listSuppliers() });

  const defaultSupplierId = [...rows]
    .filter((r) => r.lastSupplier)
    .sort((a, b) => (b.lastSupplier!.lastPurchasedAt > a.lastSupplier!.lastPurchasedAt ? 1 : -1))[0]?.lastSupplier?.id;

  const [supplierId, setSupplierId] = useState(defaultSupplierId ?? "");
  const [supplierInvoiceNumber, setSupplierInvoiceNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [unitPrices, setUnitPrices] = useState<Record<string, string>>(() =>
    Object.fromEntries(rows.map((r) => [r.ingredientId, r.lastSupplier?.lastUnitPrice ?? ""])),
  );
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => {
      const items: PurchaseInvoiceItemInput[] = rows.map((r) => ({
        description: localizedName({ name: r.ingredientName, nameEn: r.ingredientNameEn }, i18n.language),
        itemType: "stock",
        quantity: quantities[r.ingredientId] ?? r.suggestedQuantity,
        unitPrice: unitPrices[r.ingredientId] ?? "0",
        ingredientId: r.ingredientId,
      }));
      return purchasesApi.createInvoice({
        supplierId,
        branchId,
        supplierInvoiceNumber,
        invoiceDate,
        confirm: false,
        items,
      });
    },
    onSuccess: onCreated,
    onError: (e) => setError(e instanceof ApiError ? e.message : t("common.error")),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!supplierId) {
      setError(t("inventory.reorderAlerts.form.chooseSupplier"));
      return;
    }
    if (rows.some((r) => !Number((quantities[r.ingredientId] ?? r.suggestedQuantity)) || !unitPrices[r.ingredientId])) {
      setError(t("inventory.reorderAlerts.form.incompleteLine"));
      return;
    }
    create.mutate();
  }

  return (
    <Dialog open onClose={onClose} title={t("inventory.reorderAlerts.createDraftInvoiceTitle")} className="max-w-2xl">
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert variant="destructive">{error}</Alert>}

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="rasupplier">{t("purchases.invoices.supplier")}</Label>
            <Select id="rasupplier" required value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="" disabled>
                {t("purchases.invoices.form.chooseSupplier")}
              </option>
              {suppliers.data?.map((s: Supplier) => (
                <option key={s.id} value={s.id}>
                  {localizedName(s, i18n.language)}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ranumber">{t("purchases.invoices.form.supplierInvoiceNumber")}</Label>
            <Input
              id="ranumber"
              dir="ltr"
              required
              value={supplierInvoiceNumber}
              onChange={(e) => setSupplierInvoiceNumber(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="radate">{t("purchases.invoices.date")}</Label>
            <Input id="radate" type="date" required value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
          </div>
        </div>

        <div className="space-y-2">
          <Label>{t("inventory.reorderAlerts.form.items")}</Label>
          <div className="space-y-3 rounded-lg border p-3">
            {rows.map((row) => (
              <div key={row.ingredientId} className="space-y-2 rounded-lg border bg-muted/20 p-3">
                <p className="text-sm font-medium">
                  {localizedName({ name: row.ingredientName, nameEn: row.ingredientNameEn }, i18n.language)}
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs">{t("inventory.reorderAlerts.suggestedQuantity")}</Label>
                    <Input
                      dir="ltr"
                      inputMode="decimal"
                      required
                      value={quantities[row.ingredientId] ?? row.suggestedQuantity}
                      onChange={(e) => onQuantityChange(row.ingredientId, e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">{t("purchases.invoices.form.unitPrice")}</Label>
                    <Input
                      dir="ltr"
                      inputMode="decimal"
                      required
                      value={unitPrices[row.ingredientId] ?? ""}
                      onChange={(e) => setUnitPrices((p) => ({ ...p, [row.ingredientId]: e.target.value }))}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {t("catalog.cancel")}
          </Button>
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? <Spinner className="border-primary-foreground" /> : t("inventory.reorderAlerts.form.saveDraft")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
