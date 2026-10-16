import { Minus, Plus, Send, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  Input,
  Select,
  Spinner,
  cn,
} from "@spruvex-r/ui";

import { api, ApiError, post } from "../lib/api";
import {
  cartTotal,
  formatSar,
  isAvailableInBranch,
  lineTotal,
  productPrice,
  toHalalas,
  type CartLine,
  type MenuModifier,
  type MenuProduct,
} from "../lib/cart";
import { isNetworkError, offlineQueue, type SyncState } from "../lib/offline-queue";
import { posApi, type Shift } from "../lib/pos-api";
import { PaymentDialog } from "../components/PaymentDialog";
import { ShiftBar } from "../components/ShiftBar";
import { OrdersScreen } from "./OrdersScreen";
import { SessionsScreen } from "./SessionsScreen";

const ACTIVE_ORDER_STATUSES = new Set(["new", "confirmed", "preparing", "ready", "served"]);

interface Category {
  id: string;
  name: string;
  nameEn: string | null;
  isActive: boolean;
}

interface DiningTable {
  id: string;
  number: string;
  status: string;
}

function newLineId(): string {
  return crypto.randomUUID();
}

export function PosScreen({
  branchId,
  onSwitchBranch,
  onLogout,
}: {
  branchId: string;
  onSwitchBranch: () => void;
  onLogout: () => void;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const name = (item: { name: string; nameEn: string | null }) =>
    lang === "en" && item.nameEn ? item.nameEn : item.name;

  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<MenuProduct[]>([]);
  const [tables, setTables] = useState<DiningTable[]>([]);
  const [loading, setLoading] = useState(true);

  const [categoryFilter, setCategoryFilter] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [orderType, setOrderType] = useState<"walkin" | "dine_in">("walkin");
  const [tableId, setTableId] = useState("");
  const [orderNotes, setOrderNotes] = useState("");
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const [tab, setTab] = useState<"menu" | "orders" | "sessions">("menu");
  const [shift, setShift] = useState<Shift | null>(null);
  const [sync, setSync] = useState<SyncState>({ pending: 0, syncing: false });
  const [payFor, setPayFor] = useState<{ id: string; orderNumber: number } | null>(null);

  useEffect(() => {
    offlineQueue.start();
    const unsubscribe = offlineQueue.subscribe(setSync);
    return () => {
      unsubscribe();
      offlineQueue.stop();
    };
  }, []);

  // Modifier picker state
  const [picking, setPicking] = useState<MenuProduct | null>(null);
  const [selected, setSelected] = useState<MenuModifier[]>([]);
  const [pickError, setPickError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const [cats, prods, tbls] = await Promise.all([
        api<Category[]>("/catalog/categories"),
        api<MenuProduct[]>("/catalog/products"),
        api<DiningTable[]>(`/tables?branchId=${branchId}`),
      ]);
      setCategories(cats.filter((c) => c.isActive));
      setProducts(prods);
      setTables(tbls);
      setLoading(false);
    })();
  }, [branchId]);

  const visibleProducts = useMemo(
    () =>
      products.filter(
        (product) =>
          isAvailableInBranch(product, branchId) &&
          (!categoryFilter || product.categoryId === categoryFilter),
      ),
    [products, branchId, categoryFilter],
  );

  function pickProduct(product: MenuProduct) {
    const groups = product.modifierGroups.map((link) => link.group);
    if (groups.length === 0) {
      addLine(product, []);
      return;
    }
    setSelected([]);
    setPickError(null);
    setPicking(product);
  }

  function addLine(product: MenuProduct, modifiers: MenuModifier[]) {
    setCart((current) => [
      ...current,
      { lineId: newLineId(), product, quantity: 1, modifiers },
    ]);
  }

  function confirmPick() {
    if (!picking) return;
    for (const link of picking.modifierGroups) {
      const group = link.group;
      const count = selected.filter((m) =>
        group.modifiers.some((gm) => gm.id === m.id),
      ).length;
      const min = group.isRequired ? Math.max(group.minSelect, 1) : group.minSelect;
      if (count < min) {
        setPickError(`${name(group)}: ${t("pos.chooseMin", { count: min })}`);
        return;
      }
      if (group.maxSelect != null && count > group.maxSelect) {
        setPickError(`${name(group)}: ≤ ${group.maxSelect}`);
        return;
      }
    }
    addLine(picking, selected);
    setPicking(null);
  }

  function changeQty(lineId: string, delta: number) {
    setCart((current) =>
      current
        .map((line) =>
          line.lineId === lineId ? { ...line, quantity: line.quantity + delta } : line,
        )
        .filter((line) => line.quantity > 0),
    );
  }

  async function send() {
    if (cart.length === 0 || sending) return;
    if (orderType === "dine_in" && !tableId) {
      setFeedback({ kind: "error", text: t("pos.chooseTable") });
      return;
    }
    setSending(true);
    setFeedback(null);
    const items = cart.map((line) => ({
      productId: line.product.id,
      quantity: line.quantity,
      ...(line.modifiers.length > 0 ? { modifierIds: line.modifiers.map((m) => m.id) } : {}),
      ...(line.notes ? { notes: line.notes } : {}),
    }));
    const idempotencyKey = crypto.randomUUID();
    const body = {
      type: orderType,
      ...(orderType === "dine_in" ? { tableId } : { branchId }),
      confirm: true,
      ...(orderNotes ? { notes: orderNotes } : {}),
      items,
    };
    // A dine-in table already mid-session (someone scanned its QR, or an
    // earlier round was sent) must gain a new ROUND on that same order,
    // never a second separate one — the whole table settles as one bill.
    let existingSessionOrder: { id: string; orderNumber: number } | null = null;
    try {
      // Re-check right before sending rather than trusting cached state, to
      // keep the window where two staff members could race as small as
      // possible (the server's row lock is still the real guarantee).
      if (orderType === "dine_in" && tableId) {
        const openSessions = await posApi.listOpenSessions(branchId);
        const match = openSessions.find((s) => s.table.id === tableId);
        if (match?.order && ACTIVE_ORDER_STATUSES.has(match.order.status)) {
          existingSessionOrder = match.order;
        }
      }

      const order = existingSessionOrder
        ? await posApi.appendItemsToOrder(existingSessionOrder.id, items)
        : await post<{ id: string; orderNumber: number }>("/orders", body, {
            "Idempotency-Key": idempotencyKey,
          });
      setCart([]);
      setOrderNotes("");
      setFeedback({ kind: "ok", text: t("pos.sent", { number: order.orderNumber }) });
      // Walk-in counter orders go straight to the payment screen.
      if (orderType === "walkin" && shift) {
        setPayFor({ id: order.id, orderNumber: order.orderNumber });
      }
    } catch (e) {
      if (isNetworkError(e) && !existingSessionOrder) {
        // Degraded mode: queue for automatic retry with the same key. The
        // offline queue only knows how to replay order CREATION (see
        // offline-queue.ts) — an append to an existing session order can't
        // be queued that way without risking a duplicate order once back
        // online, so that case surfaces as an error below instead.
        offlineQueue.enqueue(idempotencyKey, body);
        setCart([]);
        setOrderNotes("");
        setFeedback({ kind: "ok", text: t("pos.queued") });
      } else {
        setFeedback({
          kind: "error",
          text: e instanceof ApiError ? e.message : t("auth.error"),
        });
      }
    } finally {
      setSending(false);
    }
  }

  const total = cartTotal(cart, branchId);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner className="h-10 w-10" />
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b bg-card px-4 py-2">
        <div className="flex items-center gap-3">
          <img src="/logo-horizontal.png" alt="SpruVex R" className="h-8 object-contain" />
          <div className="flex gap-1 rounded-lg bg-muted p-1">
            {(["menu", "orders", "sessions"] as const).map((key) => (
              <button
                key={key}
                type="button"
                className={cn(
                  "rounded-md px-3 py-1 text-sm font-medium",
                  tab === key ? "bg-primary text-primary-foreground" : "text-muted-foreground",
                )}
                onClick={() => setTab(key)}
              >
                {t(`tabs.${key}`)}
              </button>
            ))}
          </div>
          <ShiftBar branchId={branchId} shift={shift} onShiftChange={setShift} />
          {sync.pending > 0 && (
            <Badge variant="destructive">
              {sync.syncing ? t("sync.syncing") : t("sync.pending", { count: sync.pending })}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => i18n.changeLanguage(lang === "ar" ? "en" : "ar")}
          >
            {t("common.language")}
          </Button>
          <Button variant="ghost" size="sm" onClick={onSwitchBranch}>
            {t("branch.select")}
          </Button>
          <Button variant="outline" size="sm" onClick={onLogout}>
            {t("auth.logout")}
          </Button>
        </div>
      </header>

      {payFor && (
        <PaymentDialog
          orderId={payFor.id}
          orderNumber={payFor.orderNumber}
          onClose={() => setPayFor(null)}
          onCompleted={() => undefined}
        />
      )}

      {tab === "orders" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <OrdersScreen branchId={branchId} />
        </div>
      ) : tab === "sessions" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <SessionsScreen
            branchId={branchId}
            onAddItems={(clickedTableId) => {
              setOrderType("dine_in");
              setTableId(clickedTableId);
              setTab("menu");
            }}
          />
        </div>
      ) : (
      <div className="flex min-h-0 flex-1">
        {/* Menu side */}
        <main className="flex min-w-0 flex-1 flex-col p-3">
          <div className="mb-3 flex gap-2 overflow-x-auto">
            <Button
              variant={categoryFilter === "" ? "default" : "secondary"}
              onClick={() => setCategoryFilter("")}
            >
              {t("pos.all")}
            </Button>
            {categories.map((category) => (
              <Button
                key={category.id}
                variant={categoryFilter === category.id ? "default" : "secondary"}
                onClick={() => setCategoryFilter(category.id)}
              >
                {name(category)}
              </Button>
            ))}
          </div>
          <div className="grid flex-1 auto-rows-min grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-3 xl:grid-cols-4">
            {visibleProducts.map((product) => (
              <button
                key={product.id}
                type="button"
                className="flex min-h-24 flex-col items-start justify-between rounded-xl border-2 bg-card p-3 text-start shadow-sm transition-colors hover:border-primary active:bg-secondary"
                onClick={() => pickProduct(product)}
              >
                <span className="text-base font-semibold leading-snug">{name(product)}</span>
                <span className="mt-2 font-bold text-primary" dir="ltr">
                  {formatSar(productPrice(product, branchId))} {t("pos.sar")}
                </span>
              </button>
            ))}
          </div>
        </main>

        {/* Cart side */}
        <aside className="flex w-96 shrink-0 flex-col border-s bg-card">
          <div className="flex items-center justify-between border-b p-3">
            <h2 className="font-bold">{t("pos.cart")}</h2>
            <div className="flex gap-1 rounded-lg bg-muted p-1">
              {(["walkin", "dine_in"] as const).map((type) => (
                <button
                  key={type}
                  type="button"
                  className={cn(
                    "rounded-md px-3 py-1 text-sm font-medium",
                    orderType === type ? "bg-primary text-primary-foreground" : "text-muted-foreground",
                  )}
                  onClick={() => setOrderType(type)}
                >
                  {type === "walkin" ? t("pos.walkin") : t("pos.dineIn")}
                </button>
              ))}
            </div>
          </div>

          {orderType === "dine_in" && (
            <div className="border-b p-3">
              <Select value={tableId} onChange={(e) => setTableId(e.target.value)}>
                <option value="">{t("pos.chooseTable")}</option>
                {tables
                  .filter((table) => table.status !== "disabled")
                  .map((table) => (
                    <option key={table.id} value={table.id}>
                      {t("pos.table", { number: table.number })}
                    </option>
                  ))}
              </Select>
            </div>
          )}

          <div className="flex-1 space-y-2 overflow-y-auto p-3">
            {cart.length === 0 && (
              <p className="p-4 text-center text-sm text-muted-foreground">{t("pos.empty")}</p>
            )}
            {cart.map((line) => (
              <Card key={line.lineId}>
                <CardContent className="space-y-1 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold">{name(line.product)}</span>
                    <span className="font-bold" dir="ltr">
                      {formatSar(lineTotal(line, branchId))}
                    </span>
                  </div>
                  {line.modifiers.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {line.modifiers
                        .map(
                          (modifier) =>
                            `${name(modifier)}${
                              toHalalas(modifier.priceAdjustment) !== 0
                                ? ` (${formatSar(toHalalas(modifier.priceAdjustment))}+)`
                                : ""
                            }`,
                        )
                        .join(" · ")}
                    </p>
                  )}
                  <div className="flex items-center justify-between pt-1">
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="icon"
                        aria-label={t("pos.decreaseQty")}
                        onClick={() => changeQty(line.lineId, -1)}
                      >
                        <Minus className="h-4 w-4" />
                      </Button>
                      <span className="w-6 text-center font-bold" dir="ltr">
                        {line.quantity}
                      </span>
                      <Button
                        variant="outline"
                        size="icon"
                        aria-label={t("pos.increaseQty")}
                        onClick={() => changeQty(line.lineId, 1)}
                      >
                        <Plus className="h-4 w-4" />
                      </Button>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t("pos.removeItem")}
                      onClick={() =>
                        setCart((current) => current.filter((l) => l.lineId !== line.lineId))
                      }
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          <div className="space-y-3 border-t p-3">
            {feedback && (
              <Alert variant={feedback.kind === "error" ? "destructive" : "default"}>
                {feedback.text}
              </Alert>
            )}
            <Input
              placeholder={t("pos.notes")}
              value={orderNotes}
              onChange={(e) => setOrderNotes(e.target.value)}
            />
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">{t("pos.total")}</span>
              <span className="text-2xl font-extrabold text-primary" dir="ltr">
                {formatSar(total)} {t("pos.sar")}
              </span>
            </div>
            <Button
              size="lg"
              className="w-full text-lg"
              disabled={cart.length === 0 || sending}
              onClick={send}
            >
              {sending ? (
                <Spinner className="border-primary-foreground" />
              ) : (
                <>
                  <Send className="h-5 w-5" /> {t("pos.send")}
                </>
              )}
            </Button>
          </div>
        </aside>
      </div>
      )}

      {/* Modifier picker */}
      <Dialog
        open={picking !== null}
        onClose={() => setPicking(null)}
        title={picking ? name(picking) : undefined}
      >
        {picking && (
          <div className="space-y-4">
            {pickError && <Alert variant="destructive">{pickError}</Alert>}
            {picking.modifierGroups.map((link) => {
              const group = link.group;
              const single = group.maxSelect === 1;
              return (
                <div key={group.id} className="space-y-2">
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold">{name(group)}</h3>
                    {group.isRequired && <Badge variant="success">{t("pos.required")}</Badge>}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {group.modifiers
                      .filter((modifier) => modifier.isActive)
                      .map((modifier) => {
                        const isSelected = selected.some((m) => m.id === modifier.id);
                        return (
                          <button
                            key={modifier.id}
                            type="button"
                            className={cn(
                              "rounded-full border-2 px-4 py-2 text-sm font-medium transition-colors",
                              isSelected
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-border bg-card hover:border-primary/60",
                            )}
                            onClick={() =>
                              setSelected((current) => {
                                if (isSelected) {
                                  return current.filter((m) => m.id !== modifier.id);
                                }
                                const withoutGroup = single
                                  ? current.filter(
                                      (m) => !group.modifiers.some((gm) => gm.id === m.id),
                                    )
                                  : current;
                                return [...withoutGroup, modifier];
                              })
                            }
                          >
                            {name(modifier)}
                            {toHalalas(modifier.priceAdjustment) !== 0 && (
                              <span className="ms-1 text-xs" dir="ltr">
                                +{formatSar(toHalalas(modifier.priceAdjustment))}
                              </span>
                            )}
                          </button>
                        );
                      })}
                  </div>
                </div>
              );
            })}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setPicking(null)}>
                {t("pos.cancel")}
              </Button>
              <Button onClick={confirmPick}>{t("pos.add")}</Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
