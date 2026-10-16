import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Badge, Button, Card, CardContent, Dialog, Input, Label, Select, Spinner } from "@spruvex-r/ui";

import { api, ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { localizedName } from "../../lib/catalog-api";
import { inventoryApi } from "../../lib/inventory-api";
import {
  stockTransfersApi,
  type ReceiveStockTransferItemInput,
  type StockTransfer,
  type StockTransferStatus,
} from "../../lib/stock-transfers-api";

interface BranchRow {
  id: string;
  name: string;
  nameEn: string | null;
}

const STATUS_VARIANT: Record<StockTransferStatus, "muted" | "default" | "success" | "destructive"> = {
  draft: "muted",
  sent: "default",
  received: "success",
  rejected: "destructive",
  cancelled: "destructive",
};

interface ItemRow {
  key: string;
  ingredientId: string;
  quantity: string;
}

function newRow(): ItemRow {
  return { key: crypto.randomUUID(), ingredientId: "", quantity: "" };
}

export function StockTransfersPage() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const canCreate = Boolean(user?.permissions.includes("inventory.transfer.create"));
  const canReceive = Boolean(user?.permissions.includes("inventory.transfer.receive"));
  const queryClient = useQueryClient();

  const branches = useQuery({ queryKey: ["branches"], queryFn: () => api<BranchRow[]>("/branches") });
  const [branchId, setBranchId] = useState("");
  const activeBranchId = branchId || branches.data?.[0]?.id || "";

  const [statusFilter, setStatusFilter] = useState<StockTransferStatus | "">("");

  const transfers = useQuery({
    queryKey: ["inventory", "transfers", activeBranchId, statusFilter],
    queryFn: () =>
      stockTransfersApi.list({
        branchId: activeBranchId,
        ...(statusFilter ? { status: statusFilter } : {}),
      }),
    enabled: Boolean(activeBranchId),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["inventory", "transfers"] });

  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Select className="w-48" value={activeBranchId} onChange={(e) => setBranchId(e.target.value)}>
            {branches.data?.map((b) => (
              <option key={b.id} value={b.id}>
                {localizedName({ name: b.name, nameEn: b.nameEn }, i18n.language)}
              </option>
            ))}
          </Select>
          <Select
            className="w-40"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StockTransferStatus | "")}
          >
            <option value="">{t("inventory.transfers.allStatuses")}</option>
            {(["draft", "sent", "received", "rejected", "cancelled"] as const).map((s) => (
              <option key={s} value={s}>
                {t(`inventory.transfers.status.${s}`)}
              </option>
            ))}
          </Select>
        </div>
        {canCreate && (
          <Button onClick={() => setCreating(true)} disabled={!activeBranchId}>
            <Plus className="h-4 w-4" /> {t("inventory.transfers.add")}
          </Button>
        )}
      </div>

      {transfers.isLoading && <Spinner />}
      {transfers.data?.length === 0 && <p className="text-muted-foreground">{t("inventory.transfers.empty")}</p>}

      <Card>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="p-3 text-start">{t("inventory.transfers.from")}</th>
                <th className="p-3 text-start">{t("inventory.transfers.to")}</th>
                <th className="p-3 text-start">{t("inventory.transfers.itemCount")}</th>
                <th className="p-3 text-start">{t("inventory.transfers.status.title")}</th>
                <th className="p-3 text-start">{t("inventory.transfers.updatedAt")}</th>
              </tr>
            </thead>
            <tbody>
              {transfers.data?.map((transfer) => (
                <TransferRow
                  key={transfer.id}
                  transfer={transfer}
                  branches={branches.data ?? []}
                  language={i18n.language}
                  onOpen={() => setViewing(transfer.id)}
                />
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {creating && activeBranchId && (
        <CreateTransferDialog
          fromBranchId={activeBranchId}
          branches={(branches.data ?? []).filter((b) => b.id !== activeBranchId)}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void invalidate();
          }}
        />
      )}

      {viewing && (
        <TransferDetailDialog
          id={viewing}
          branches={branches.data ?? []}
          canCreate={canCreate}
          canReceive={canReceive}
          onClose={() => setViewing(null)}
          onChanged={() => void invalidate()}
        />
      )}
    </div>
  );
}

function branchName(branches: BranchRow[], id: string, language: string): string {
  const b = branches.find((x) => x.id === id);
  return b ? localizedName({ name: b.name, nameEn: b.nameEn }, language) : id;
}

function TransferRow({
  transfer,
  branches,
  language,
  onOpen,
}: {
  transfer: StockTransfer;
  branches: BranchRow[];
  language: string;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  return (
    <tr className="cursor-pointer border-b last:border-0 hover:bg-muted/30" onClick={onOpen}>
      <td className="p-3">{branchName(branches, transfer.fromBranchId, language)}</td>
      <td className="p-3">{branchName(branches, transfer.toBranchId, language)}</td>
      <td className="p-3" dir="ltr">
        {transfer.items.length}
      </td>
      <td className="p-3">
        <Badge variant={STATUS_VARIANT[transfer.status]}>{t(`inventory.transfers.status.${transfer.status}`)}</Badge>
      </td>
      <td className="p-3 text-muted-foreground" dir="ltr">
        {transfer.updatedAt.slice(0, 10)}
      </td>
    </tr>
  );
}

function CreateTransferDialog({
  fromBranchId,
  branches,
  onClose,
  onCreated,
}: {
  fromBranchId: string;
  branches: BranchRow[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t, i18n } = useTranslation();
  const ingredients = useQuery({ queryKey: ["inventory", "ingredients"], queryFn: inventoryApi.listIngredients });
  const levels = useQuery({
    queryKey: ["inventory", "levels", fromBranchId],
    queryFn: () => inventoryApi.listLevels(fromBranchId),
  });

  const availableByIngredient = new Map<string, number>();
  for (const level of levels.data ?? []) {
    availableByIngredient.set(
      level.ingredientId,
      (availableByIngredient.get(level.ingredientId) ?? 0) + Number(level.quantity),
    );
  }

  const [toBranchId, setToBranchId] = useState("");
  const [rows, setRows] = useState<ItemRow[]>([newRow()]);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<"draft" | "send" | null>(null);

  function updateRow(key: string, patch: Partial<ItemRow>) {
    setRows((current) => current.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function rowExceedsStock(row: ItemRow): boolean {
    if (!row.ingredientId || !row.quantity) return false;
    const available = availableByIngredient.get(row.ingredientId) ?? 0;
    return Number(row.quantity) > available;
  }

  const hasBlockingError = rows.some((r) => !r.ingredientId || !r.quantity || rowExceedsStock(r));

  const createAndMaybeSend = useMutation({
    mutationFn: async (action: "draft" | "send") => {
      const created = await stockTransfersApi.create({
        fromBranchId,
        toBranchId,
        items: rows.map((r) => ({ ingredientId: r.ingredientId, quantity: r.quantity })),
      });
      if (action === "send") {
        try {
          await stockTransfersApi.send(created.id);
        } catch (e) {
          return {
            sendFailed: true,
            message: e instanceof ApiError ? e.message : t("common.error"),
          };
        }
      }
      return { sendFailed: false, message: "" };
    },
    onSuccess: (result) => {
      if (result.sendFailed) {
        alert(t("inventory.transfers.form.createdButSendFailed", { message: result.message }));
      }
      onCreated();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t("common.error")),
  });

  function submit(event: FormEvent, action: "draft" | "send") {
    event.preventDefault();
    setError(null);
    if (!toBranchId) {
      setError(t("inventory.transfers.form.chooseDestination"));
      return;
    }
    if (rows.length === 0) {
      setError(t("inventory.transfers.form.needAtLeastOneItem"));
      return;
    }
    if (rows.some((r) => !r.ingredientId || !r.quantity)) {
      setError(t("inventory.transfers.form.incompleteLine"));
      return;
    }
    if (rows.some(rowExceedsStock)) {
      setError(t("inventory.transfers.form.exceedsStock"));
      return;
    }
    setPendingAction(action);
    createAndMaybeSend.mutate(action);
  }

  return (
    <Dialog open onClose={onClose} title={t("inventory.transfers.add")} className="max-w-2xl">
      <form className="space-y-4">
        {error && <Alert variant="destructive">{error}</Alert>}

        <div className="space-y-2">
          <Label htmlFor="ttobranch">{t("inventory.transfers.form.destination")}</Label>
          <Select id="ttobranch" required value={toBranchId} onChange={(e) => setToBranchId(e.target.value)}>
            <option value="" disabled>
              {t("inventory.transfers.form.chooseDestination")}
            </option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {localizedName({ name: b.name, nameEn: b.nameEn }, i18n.language)}
              </option>
            ))}
          </Select>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>{t("inventory.transfers.form.items")}</Label>
            <Button type="button" variant="outline" size="sm" onClick={() => setRows([...rows, newRow()])}>
              <Plus className="h-4 w-4" /> {t("inventory.transfers.form.addLine")}
            </Button>
          </div>
          <div className="space-y-3 rounded-lg border p-3">
            {rows.map((row) => {
              const available = row.ingredientId ? (availableByIngredient.get(row.ingredientId) ?? 0) : null;
              const exceeds = rowExceedsStock(row);
              return (
                <div key={row.key} className="space-y-2 rounded-lg border bg-muted/20 p-3">
                  <div className="flex items-start gap-2">
                    <div className="flex-1 space-y-2">
                      <Select
                        required
                        value={row.ingredientId}
                        onChange={(e) => updateRow(row.key, { ingredientId: e.target.value })}
                      >
                        <option value="" disabled>
                          {t("inventory.transfers.form.chooseIngredient")}
                        </option>
                        {ingredients.data?.map((ing) => (
                          <option key={ing.id} value={ing.id}>
                            {localizedName(ing, i18n.language)}
                          </option>
                        ))}
                      </Select>
                      <div className="space-y-1">
                        <Input
                          dir="ltr"
                          inputMode="decimal"
                          required
                          placeholder={t("inventory.transfers.form.quantity")}
                          value={row.quantity}
                          onChange={(e) => updateRow(row.key, { quantity: e.target.value })}
                          className={exceeds ? "border-destructive" : undefined}
                        />
                        {row.ingredientId && (
                          <p className={`text-xs ${exceeds ? "text-destructive" : "text-muted-foreground"}`} dir="ltr">
                            {t("inventory.transfers.form.available", { quantity: available })}
                          </p>
                        )}
                      </div>
                    </div>
                    {rows.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={t("inventory.transfers.form.removeLine")}
                        onClick={() => setRows(rows.filter((r) => r.key !== row.key))}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {t("catalog.cancel")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={createAndMaybeSend.isPending || hasBlockingError}
            onClick={(e) => submit(e, "draft")}
          >
            {createAndMaybeSend.isPending && pendingAction === "draft" ? (
              <Spinner />
            ) : (
              t("inventory.transfers.form.saveDraft")
            )}
          </Button>
          <Button
            type="button"
            disabled={createAndMaybeSend.isPending || hasBlockingError}
            onClick={(e) => submit(e, "send")}
          >
            {createAndMaybeSend.isPending && pendingAction === "send" ? (
              <Spinner className="border-primary-foreground" />
            ) : (
              t("inventory.transfers.form.sendNow")
            )}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function TransferDetailDialog({
  id,
  branches,
  canCreate,
  canReceive,
  onClose,
  onChanged,
}: {
  id: string;
  branches: BranchRow[];
  canCreate: boolean;
  canReceive: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const [cancelReason, setCancelReason] = useState("");
  const [showCancelForm, setShowCancelForm] = useState(false);

  const [rejectReason, setRejectReason] = useState("");
  const [showRejectForm, setShowRejectForm] = useState(false);

  const [receivedQty, setReceivedQty] = useState<Record<string, string>>({});
  const [discrepancyReason, setDiscrepancyReason] = useState<Record<string, string>>({});
  const [showReceiveForm, setShowReceiveForm] = useState(false);

  const detail = useQuery({
    queryKey: ["inventory", "transfers", id],
    queryFn: () => stockTransfersApi.get(id),
  });
  const ingredients = useQuery({ queryKey: ["inventory", "ingredients"], queryFn: inventoryApi.listIngredients });
  const ingredientName = (ingredientId: string) => {
    const ing = ingredients.data?.find((i) => i.id === ingredientId);
    return ing ? localizedName(ing, i18n.language) : ingredientId;
  };

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["inventory", "transfers", id] });
    onChanged();
  };

  const send = useMutation({
    mutationFn: () => stockTransfersApi.send(id),
    onSuccess: refresh,
    onError: (e) => setError(e instanceof ApiError ? e.message : t("common.error")),
  });

  const cancel = useMutation({
    mutationFn: () => stockTransfersApi.cancel(id, cancelReason),
    onSuccess: () => {
      setShowCancelForm(false);
      refresh();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t("common.error")),
  });

  const reject = useMutation({
    mutationFn: () => stockTransfersApi.reject(id, rejectReason),
    onSuccess: () => {
      setShowRejectForm(false);
      refresh();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t("common.error")),
  });

  const receive = useMutation({
    mutationFn: () => {
      const transfer = detail.data!;
      const items: ReceiveStockTransferItemInput[] = transfer.items.map((item) => {
        const qty = receivedQty[item.id] ?? item.sentQuantity;
        const short = Number(qty) < Number(item.sentQuantity);
        return {
          stockTransferItemId: item.id,
          receivedQuantity: qty,
          ...(short ? { discrepancyReason: discrepancyReason[item.id] ?? "" } : {}),
        };
      });
      return stockTransfersApi.receive(id, items);
    },
    onSuccess: () => {
      setShowReceiveForm(false);
      refresh();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t("common.error")),
  });

  function openReceiveForm() {
    const transfer = detail.data;
    if (!transfer) return;
    const initial: Record<string, string> = {};
    for (const item of transfer.items) initial[item.id] = item.sentQuantity;
    setReceivedQty(initial);
    setDiscrepancyReason({});
    setShowReceiveForm(true);
  }

  const transfer = detail.data as StockTransfer | undefined;

  const receiveBlocked =
    transfer?.items.some((item) => {
      const qty = receivedQty[item.id] ?? item.sentQuantity;
      const short = Number(qty) < Number(item.sentQuantity);
      return short && !discrepancyReason[item.id]?.trim();
    }) ?? false;

  return (
    <Dialog
      open
      onClose={onClose}
      title={
        transfer
          ? `${branchName(branches, transfer.fromBranchId, i18n.language)} → ${branchName(branches, transfer.toBranchId, i18n.language)}`
          : t("common.loading")
      }
      className="max-w-2xl"
    >
      {!transfer ? (
        <Spinner />
      ) : (
        <div className="space-y-4">
          {error && <Alert variant="destructive">{error}</Alert>}

          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={STATUS_VARIANT[transfer.status]}>{t(`inventory.transfers.status.${transfer.status}`)}</Badge>
            <span className="text-sm text-muted-foreground" dir="ltr">
              {transfer.updatedAt.slice(0, 10)}
            </span>
          </div>

          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="p-2 text-start">{t("inventory.transfers.form.ingredient")}</th>
                  <th className="p-2 text-start">{t("inventory.transfers.form.sentQuantity")}</th>
                  {!showReceiveForm && <th className="p-2 text-start">{t("inventory.transfers.form.receivedQuantity")}</th>}
                  {!showReceiveForm && <th className="p-2 text-start">{t("inventory.transfers.form.discrepancyReason")}</th>}
                  {showReceiveForm && <th className="p-2 text-start">{t("inventory.transfers.form.receivedQuantity")}</th>}
                </tr>
              </thead>
              <tbody>
                {transfer.items.map((item) => {
                  const qty = receivedQty[item.id] ?? item.sentQuantity;
                  const short = showReceiveForm && Number(qty) < Number(item.sentQuantity);
                  return (
                    <tr key={item.id} className="border-b align-top last:border-0">
                      <td className="p-2">{ingredientName(item.ingredientId)}</td>
                      <td className="p-2" dir="ltr">
                        {item.sentQuantity}
                      </td>
                      {showReceiveForm ? (
                        <td className="p-2">
                          <Input
                            dir="ltr"
                            inputMode="decimal"
                            value={qty}
                            onChange={(e) =>
                              setReceivedQty((current) => ({ ...current, [item.id]: e.target.value }))
                            }
                          />
                          {short && (
                            <Input
                              className="mt-1"
                              placeholder={t("inventory.transfers.form.discrepancyReasonPlaceholder")}
                              value={discrepancyReason[item.id] ?? ""}
                              onChange={(e) =>
                                setDiscrepancyReason((current) => ({ ...current, [item.id]: e.target.value }))
                              }
                            />
                          )}
                        </td>
                      ) : (
                        <>
                          <td className="p-2" dir="ltr">
                            {item.receivedQuantity ?? "—"}
                          </td>
                          <td className="p-2 text-muted-foreground">{item.discrepancyReason ?? "—"}</td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {transfer.status === "rejected" && transfer.rejectReason && (
            <Alert>{t("inventory.transfers.rejectedNote", { reason: transfer.rejectReason })}</Alert>
          )}
          {transfer.status === "cancelled" && transfer.cancelReason && (
            <Alert>{t("inventory.transfers.cancelledNote", { reason: transfer.cancelReason })}</Alert>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-3">
            {canCreate && transfer.status === "draft" && (
              <Button type="button" onClick={() => send.mutate()} disabled={send.isPending}>
                {send.isPending ? <Spinner className="border-primary-foreground" /> : t("inventory.transfers.send")}
              </Button>
            )}
            {canCreate && transfer.status === "draft" && !showCancelForm && (
              <Button type="button" variant="outline" className="text-destructive" onClick={() => setShowCancelForm(true)}>
                {t("inventory.transfers.cancel")}
              </Button>
            )}
            {canReceive && transfer.status === "sent" && !showReceiveForm && !showRejectForm && (
              <Button type="button" onClick={openReceiveForm}>
                {t("inventory.transfers.receive")}
              </Button>
            )}
            {canReceive && transfer.status === "sent" && !showReceiveForm && !showRejectForm && (
              <Button
                type="button"
                variant="outline"
                className="text-destructive"
                onClick={() => setShowRejectForm(true)}
              >
                {t("inventory.transfers.reject")}
              </Button>
            )}
          </div>

          {showReceiveForm && (
            <div className="space-y-2 rounded-lg border p-3">
              <p className="text-sm text-muted-foreground">{t("inventory.transfers.form.receiveHint")}</p>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setShowReceiveForm(false)}>
                  {t("catalog.cancel")}
                </Button>
                <Button type="button" disabled={receiveBlocked || receive.isPending} onClick={() => receive.mutate()}>
                  {receive.isPending ? <Spinner className="border-primary-foreground" /> : t("inventory.transfers.confirmReceive")}
                </Button>
              </div>
            </div>
          )}

          {showCancelForm && (
            <div className="space-y-2 rounded-lg border border-destructive/40 p-3">
              <Label htmlFor="ttcancelreason">{t("inventory.transfers.form.cancelReason")}</Label>
              <Input id="ttcancelreason" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
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
                  {cancel.isPending ? <Spinner className="border-primary-foreground" /> : t("inventory.transfers.confirmCancel")}
                </Button>
              </div>
            </div>
          )}

          {showRejectForm && (
            <div className="space-y-2 rounded-lg border border-destructive/40 p-3">
              <Alert>{t("inventory.transfers.rejectWarning")}</Alert>
              <Label htmlFor="ttrejectreason">{t("inventory.transfers.form.rejectReason")}</Label>
              <Input id="ttrejectreason" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setShowRejectForm(false)}>
                  {t("catalog.cancel")}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={!rejectReason || reject.isPending}
                  onClick={() => reject.mutate()}
                >
                  {reject.isPending ? <Spinner className="border-primary-foreground" /> : t("inventory.transfers.confirmReject")}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
