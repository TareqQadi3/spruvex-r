import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Paperclip, Plus, Trash2 } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
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
  Textarea,
} from "@spruvex-r/ui";

import { api, ApiError, downloadFile } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { localizedName } from "../../lib/catalog-api";
import { inventoryApi } from "../../lib/inventory-api";
import {
  purchasesApi,
  type PurchaseInvoiceDetail,
  type PurchaseInvoiceItemInput,
  type PurchaseInvoiceStatus,
  type PurchaseInvoiceSummary,
  type PurchaseItemType,
} from "../../lib/purchases-api";

interface BranchRow {
  id: string;
  name: string;
  nameEn: string | null;
}

interface ItemRow {
  key: string;
  description: string;
  itemType: PurchaseItemType;
  quantity: string;
  unitPrice: string;
  vatRatePercent: string;
  ingredientId: string;
  expenseCategory: string;
}

function newRow(defaultVatRate: string): ItemRow {
  return {
    key: crypto.randomUUID(),
    description: "",
    itemType: "expense",
    quantity: "1",
    unitPrice: "",
    vatRatePercent: defaultVatRate,
    ingredientId: "",
    expenseCategory: "",
  };
}

const STATUS_VARIANT: Record<PurchaseInvoiceStatus, "muted" | "success" | "destructive"> = {
  draft: "muted",
  confirmed: "success",
  cancelled: "destructive",
};

export function PurchaseInvoicesPage() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const canCreate = Boolean(user?.permissions.includes("purchases.create"));
  const canVoid = Boolean(user?.permissions.includes("purchases.void"));
  const queryClient = useQueryClient();

  const branches = useQuery({ queryKey: ["branches"], queryFn: () => api<BranchRow[]>("/branches") });
  const suppliers = useQuery({ queryKey: ["purchases", "suppliers"], queryFn: () => purchasesApi.listSuppliers() });
  const ingredients = useQuery({ queryKey: ["inventory", "ingredients"], queryFn: inventoryApi.listIngredients });
  const settings = useQuery({ queryKey: ["purchases", "settings"], queryFn: purchasesApi.getSettings });

  const [statusFilter, setStatusFilter] = useState<PurchaseInvoiceStatus | "">("");
  const [branchFilter, setBranchFilter] = useState("");

  const invoices = useQuery({
    queryKey: ["purchases", "invoices", statusFilter, branchFilter],
    queryFn: () =>
      purchasesApi.listInvoices({
        ...(statusFilter ? { status: statusFilter } : {}),
        ...(branchFilter ? { branchId: branchFilter } : {}),
      }),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["purchases"] });

  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Select className="w-40" value={branchFilter} onChange={(e) => setBranchFilter(e.target.value)}>
            <option value="">{t("purchases.invoices.allBranches")}</option>
            {branches.data?.map((b) => (
              <option key={b.id} value={b.id}>
                {localizedName({ name: b.name, nameEn: b.nameEn }, i18n.language)}
              </option>
            ))}
          </Select>
          <Select
            className="w-40"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as PurchaseInvoiceStatus | "")}
          >
            <option value="">{t("purchases.invoices.allStatuses")}</option>
            <option value="draft">{t("purchases.invoices.status.draft")}</option>
            <option value="confirmed">{t("purchases.invoices.status.confirmed")}</option>
            <option value="cancelled">{t("purchases.invoices.status.cancelled")}</option>
          </Select>
        </div>
        {canCreate && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> {t("purchases.invoices.add")}
          </Button>
        )}
      </div>

      {invoices.isLoading && <Spinner />}
      {invoices.data?.length === 0 && <p className="text-muted-foreground">{t("purchases.invoices.empty")}</p>}

      <Card>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full min-w-[800px] text-sm">
            <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="p-3 text-start">{t("purchases.invoices.supplier")}</th>
                <th className="p-3 text-start">{t("purchases.invoices.number")}</th>
                <th className="p-3 text-start">{t("purchases.invoices.date")}</th>
                <th className="p-3 text-start">{t("purchases.invoices.status.title")}</th>
                <th className="p-3 text-start">{t("purchases.invoices.total")}</th>
                <th className="p-3" />
              </tr>
            </thead>
            <tbody>
              {invoices.data?.map((inv) => (
                <InvoiceRow
                  key={inv.id}
                  invoice={inv}
                  language={i18n.language}
                  onOpen={() => setViewing(inv.id)}
                />
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {creating && (
        <CreateInvoiceDialog
          branches={branches.data ?? []}
          suppliers={suppliers.data ?? []}
          ingredients={ingredients.data ?? []}
          defaultVatRate={settings.data?.defaultPurchaseVatRate ?? "15"}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void invalidate();
          }}
        />
      )}

      {viewing && (
        <InvoiceDetailDialog
          id={viewing}
          canVoid={canVoid}
          canCreate={canCreate}
          onClose={() => setViewing(null)}
          onChanged={() => void invalidate()}
        />
      )}
    </div>
  );
}

function InvoiceRow({
  invoice,
  language,
  onOpen,
}: {
  invoice: PurchaseInvoiceSummary;
  language: string;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  return (
    <tr className="cursor-pointer border-b last:border-0 hover:bg-muted/30" onClick={onOpen}>
      <td className="p-3">{localizedName({ name: invoice.supplier.name, nameEn: invoice.supplier.nameEn }, language)}</td>
      <td className="p-3" dir="ltr">
        {invoice.supplierInvoiceNumber}
      </td>
      <td className="p-3" dir="ltr">
        {invoice.invoiceDate.slice(0, 10)}
      </td>
      <td className="p-3">
        <Badge variant={STATUS_VARIANT[invoice.status]}>{t(`purchases.invoices.status.${invoice.status}`)}</Badge>
      </td>
      <td className="p-3 font-medium" dir="ltr">
        {invoice.total} SAR
      </td>
      <td className="p-3 text-end">
        {invoice.attachmentFilename && <Paperclip className="ms-auto h-4 w-4 text-muted-foreground" />}
      </td>
    </tr>
  );
}

function CreateInvoiceDialog({
  branches,
  suppliers,
  ingredients,
  defaultVatRate,
  onClose,
  onCreated,
}: {
  branches: BranchRow[];
  suppliers: { id: string; name: string; nameEn: string | null }[];
  ingredients: { id: string; name: string; nameEn: string | null }[];
  defaultVatRate: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [supplierId, setSupplierId] = useState("");
  const [branchId, setBranchId] = useState("");
  const [supplierInvoiceNumber, setSupplierInvoiceNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [rows, setRows] = useState<ItemRow[]>([newRow(defaultVatRate)]);
  const [confirmNow, setConfirmNow] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => {
      const items: PurchaseInvoiceItemInput[] = rows.map((r) => ({
        description: r.description,
        itemType: r.itemType,
        quantity: r.quantity,
        unitPrice: r.unitPrice,
        ...(r.vatRatePercent ? { vatRatePercent: r.vatRatePercent } : {}),
        ...(r.itemType === "stock" ? { ingredientId: r.ingredientId } : {}),
        ...(r.itemType === "expense" && r.expenseCategory ? { expenseCategory: r.expenseCategory } : {}),
      }));
      return purchasesApi.createInvoice({
        supplierId,
        branchId,
        supplierInvoiceNumber,
        invoiceDate,
        ...(notes ? { notes } : {}),
        confirm: confirmNow,
        items,
      });
    },
    onSuccess: onCreated,
    onError: (e) => setError(e instanceof ApiError ? e.message : t("common.error")),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (rows.length === 0) {
      setError(t("purchases.invoices.form.needAtLeastOneItem"));
      return;
    }
    if (rows.some((r) => r.itemType === "stock" && !r.ingredientId)) {
      setError(t("purchases.invoices.form.stockNeedsIngredient"));
      return;
    }
    create.mutate();
  }

  function updateRow(key: string, patch: Partial<ItemRow>) {
    setRows((current) => current.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  return (
    <Dialog open onClose={onClose} title={t("purchases.invoices.add")} className="max-w-3xl">
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert variant="destructive">{error}</Alert>}

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="pisupplier">{t("purchases.invoices.supplier")}</Label>
            <Select id="pisupplier" required value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="" disabled>
                {t("purchases.invoices.form.chooseSupplier")}
              </option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {localizedName(s, i18n.language)}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="pibranch">{t("purchases.invoices.form.branch")}</Label>
            <Select id="pibranch" required value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              <option value="" disabled>
                {t("purchases.invoices.form.chooseBranch")}
              </option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {localizedName({ name: b.name, nameEn: b.nameEn }, i18n.language)}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="pinumber">{t("purchases.invoices.form.supplierInvoiceNumber")}</Label>
            <Input
              id="pinumber"
              dir="ltr"
              required
              value={supplierInvoiceNumber}
              onChange={(e) => setSupplierInvoiceNumber(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pidate">{t("purchases.invoices.date")}</Label>
            <Input
              id="pidate"
              type="date"
              required
              value={invoiceDate}
              onChange={(e) => setInvoiceDate(e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>{t("purchases.invoices.form.items")}</Label>
            <Button type="button" variant="outline" size="sm" onClick={() => setRows([...rows, newRow(defaultVatRate)])}>
              <Plus className="h-4 w-4" /> {t("purchases.invoices.form.addLine")}
            </Button>
          </div>
          <div className="space-y-3 rounded-lg border p-3">
            {rows.map((row) => (
              <div key={row.key} className="space-y-2 rounded-lg border bg-muted/20 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex gap-1 rounded-lg bg-muted p-1">
                    {(["stock", "expense"] as const).map((type) => (
                      <button
                        key={type}
                        type="button"
                        className={`rounded-md px-2 py-1 text-xs font-medium ${
                          row.itemType === type ? "bg-primary text-primary-foreground" : "text-muted-foreground"
                        }`}
                        onClick={() => updateRow(row.key, { itemType: type })}
                      >
                        {t(`purchases.invoices.form.itemType.${type}`)}
                      </button>
                    ))}
                  </div>
                  {rows.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={t("purchases.invoices.form.removeLine")}
                      onClick={() => setRows(rows.filter((r) => r.key !== row.key))}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  )}
                </div>
                <Input
                  placeholder={t("purchases.invoices.form.description")}
                  required
                  value={row.description}
                  onChange={(e) => updateRow(row.key, { description: e.target.value })}
                />
                {row.itemType === "stock" ? (
                  <Select
                    required
                    value={row.ingredientId}
                    onChange={(e) => updateRow(row.key, { ingredientId: e.target.value })}
                  >
                    <option value="" disabled>
                      {t("purchases.invoices.form.chooseIngredient")}
                    </option>
                    {ingredients.map((ing) => (
                      <option key={ing.id} value={ing.id}>
                        {localizedName(ing, i18n.language)}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    placeholder={t("purchases.invoices.form.expenseCategory")}
                    value={row.expenseCategory}
                    onChange={(e) => updateRow(row.key, { expenseCategory: e.target.value })}
                  />
                )}
                <div className="grid grid-cols-3 gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs">{t("purchases.invoices.form.quantity")}</Label>
                    <Input
                      dir="ltr"
                      inputMode="decimal"
                      required
                      value={row.quantity}
                      onChange={(e) => updateRow(row.key, { quantity: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">{t("purchases.invoices.form.unitPrice")}</Label>
                    <Input
                      dir="ltr"
                      inputMode="decimal"
                      required
                      value={row.unitPrice}
                      onChange={(e) => updateRow(row.key, { unitPrice: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">{t("purchases.invoices.form.vatRate")}</Label>
                    <Input
                      dir="ltr"
                      inputMode="decimal"
                      value={row.vatRatePercent}
                      onChange={(e) => updateRow(row.key, { vatRatePercent: e.target.value })}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="pinotes">{t("purchases.invoices.form.notes")}</Label>
          <Textarea id="pinotes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={confirmNow} onChange={(e) => setConfirmNow(e.target.checked)} />
          {t("purchases.invoices.form.confirmNow")}
        </label>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {t("catalog.cancel")}
          </Button>
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? <Spinner className="border-primary-foreground" /> : t("common.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function InvoiceDetailDialog({
  id,
  canVoid,
  canCreate,
  onClose,
  onChanged,
}: {
  id: string;
  canVoid: boolean;
  canCreate: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [showCancelForm, setShowCancelForm] = useState(false);

  const detail = useQuery({
    queryKey: ["purchases", "invoices", id],
    queryFn: () => purchasesApi.getInvoice(id),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["purchases", "invoices", id] });
    onChanged();
  };

  const confirm = useMutation({
    mutationFn: () => purchasesApi.confirmInvoice(id),
    onSuccess: refresh,
    onError: (e) => setError(e instanceof ApiError ? e.message : t("common.error")),
  });

  const cancel = useMutation({
    mutationFn: () => purchasesApi.cancelInvoice(id, cancelReason),
    onSuccess: () => {
      setShowCancelForm(false);
      refresh();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t("common.error")),
  });

  const upload = useMutation({
    mutationFn: (file: File) => purchasesApi.uploadAttachment(id, file),
    onSuccess: refresh,
    onError: (e) => setError(e instanceof ApiError ? e.message : t("common.error")),
  });

  const invoice = detail.data as PurchaseInvoiceDetail | undefined;

  return (
    <Dialog
      open
      onClose={onClose}
      title={invoice ? `${invoice.supplier.name} — ${invoice.supplierInvoiceNumber}` : t("common.loading")}
      className="max-w-2xl"
    >
      {!invoice ? (
        <Spinner />
      ) : (
        <div className="space-y-4">
          {error && <Alert variant="destructive">{error}</Alert>}

          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={STATUS_VARIANT[invoice.status]}>{t(`purchases.invoices.status.${invoice.status}`)}</Badge>
            <span className="text-sm text-muted-foreground" dir="ltr">
              {invoice.invoiceDate.slice(0, 10)}
            </span>
          </div>

          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="p-2 text-start">{t("purchases.invoices.form.description")}</th>
                  <th className="p-2 text-start">{t("purchases.invoices.form.quantity")}</th>
                  <th className="p-2 text-start">{t("purchases.invoices.form.unitPrice")}</th>
                  <th className="p-2 text-start">{t("purchases.invoices.form.vatRate")}</th>
                  <th className="p-2 text-start">{t("purchases.invoices.total")}</th>
                </tr>
              </thead>
              <tbody>
                {invoice.items.map((item) => (
                  <tr key={item.id} className="border-b last:border-0">
                    <td className="p-2">
                      {item.description}
                      <Badge variant="muted" className="ms-2">
                        {t(`purchases.invoices.form.itemType.${item.itemType}`)}
                      </Badge>
                    </td>
                    <td className="p-2" dir="ltr">
                      {item.quantity}
                    </td>
                    <td className="p-2" dir="ltr">
                      {item.unitPrice}
                    </td>
                    <td className="p-2" dir="ltr">
                      {item.vatRatePercent}%
                    </td>
                    <td className="p-2 font-medium" dir="ltr">
                      {item.lineTotal}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex justify-end gap-4 text-sm">
            <span>
              {t("purchases.invoices.form.net")}: <b dir="ltr">{invoice.subtotal}</b>
            </span>
            <span>
              {t("purchases.invoices.form.vat")}: <b dir="ltr">{invoice.vatAmount}</b>
            </span>
            <span>
              {t("purchases.invoices.total")}: <b dir="ltr">{invoice.total}</b>
            </span>
          </div>

          {invoice.status === "cancelled" && invoice.cancelReason && (
            <Alert>{t("purchases.invoices.cancelledNote", { reason: invoice.cancelReason })}</Alert>
          )}

          {invoice.reversals.length > 0 && (
            <div className="space-y-2 rounded-lg border p-3">
              <p className="text-sm font-medium">{t("purchases.invoices.reversal.title")}</p>
              {invoice.reversals.map((reversal) => (
                <div key={reversal.id} className="space-y-1">
                  {reversal.items.map((ri) => (
                    <div key={ri.id} className="flex items-center justify-between text-xs">
                      {ri.stockMovement && (
                        <span dir="ltr">
                          {t("purchases.invoices.reversal.stockLine", {
                            quantity: ri.stockMovement.quantity,
                          })}
                        </span>
                      )}
                      {ri.expense && (
                        <span dir="ltr">
                          {t("purchases.invoices.reversal.expenseLine", { total: ri.expense.total })}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,application/pdf"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) upload.mutate(file);
              }}
            />
            {canCreate && (
              <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                <Paperclip className="h-4 w-4" />
                {invoice.attachmentFilename
                  ? t("purchases.invoices.form.replaceAttachment")
                  : t("purchases.invoices.form.addAttachment")}
              </Button>
            )}
            {invoice.attachmentFilename && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  downloadFile(purchasesApi.attachmentDownloadPath(id), `${invoice.supplierInvoiceNumber}-attachment`)
                }
              >
                {t("purchases.invoices.form.downloadAttachment")}
              </Button>
            )}

            <div className="flex-1" />

            {canCreate && invoice.status === "draft" && (
              <Button type="button" onClick={() => confirm.mutate()} disabled={confirm.isPending}>
                {confirm.isPending ? <Spinner className="border-primary-foreground" /> : t("purchases.invoices.confirm")}
              </Button>
            )}
            {canVoid && invoice.status !== "cancelled" && !showCancelForm && (
              <Button type="button" variant="outline" className="text-destructive" onClick={() => setShowCancelForm(true)}>
                {t("purchases.invoices.cancel")}
              </Button>
            )}
          </div>

          {showCancelForm && (
            <div className="space-y-2 rounded-lg border border-destructive/40 p-3">
              {invoice.status === "confirmed" && (
                <Alert>{t("purchases.invoices.cancelConfirmedWarning")}</Alert>
              )}
              <Label htmlFor="cancelReason">{t("purchases.invoices.form.cancelReason")}</Label>
              <Input id="cancelReason" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setShowCancelForm(false)}>
                  {t("catalog.cancel")}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={!cancelReason || cancel.isPending}
                  onClick={() => cancel.mutate()}
                >
                  {cancel.isPending ? <Spinner className="border-primary-foreground" /> : t("purchases.invoices.confirmCancel")}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
