import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { io, type Socket } from "socket.io-client";

import { Badge, Button, Card, CardContent, Spinner, cn } from "@spruvex-r/ui";

import { api, getAccessToken, post, tryRefresh } from "../lib/api";
import { mergeOrder, NEXT_ACTION, type KdsOrder } from "../lib/orders";

const COLUMNS = [
  { key: "new", statuses: ["new", "confirmed"] },
  { key: "preparing", statuses: ["preparing"] },
  { key: "ready", statuses: ["ready"] },
] as const;

function beep() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.18);
  } catch {
    // audio not available (autoplay policy) — ignore
  }
}

function ElapsedTimer({ createdAt }: { createdAt: string }) {
  const { t } = useTranslation();
  const [, force] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => force((n) => n + 1), 10_000);
    return () => clearInterval(timer);
  }, []);
  const minutes = Math.floor((Date.now() - new Date(createdAt).getTime()) / 60_000);
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-sm font-bold",
        minutes >= 15
          ? "bg-destructive text-destructive-foreground"
          : minutes >= 10
            ? "bg-amber-500 text-black"
            : "bg-secondary text-secondary-foreground",
      )}
      dir="ltr"
    >
      {t("board.minutes", { count: minutes })}
    </span>
  );
}

export function BoardScreen({
  branchId,
  onSwitchBranch,
  onLogout,
}: {
  branchId: string;
  onSwitchBranch: () => void;
  onLogout: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [orders, setOrders] = useState<KdsOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<Socket | null>(null);

  const load = useCallback(async () => {
    const data = await api<KdsOrder[]>(
      `/orders?branchId=${branchId}&statuses=new,confirmed,preparing,ready`,
    );
    setOrders(data);
    setLoading(false);
  }, [branchId]);

  useEffect(() => {
    void load();

    let disposed = false;

    async function connect() {
      // Ensure a fresh access token for the socket handshake.
      if (!getAccessToken()) await tryRefresh();
      if (disposed) return;
      const socket = io({
        transports: ["websocket"],
        auth: { token: getAccessToken() },
      });
      socketRef.current = socket;

      socket.on("connect", async () => {
        const res = await socket.emitWithAck("subscribe", { channel: "kitchen", branchId });
        setConnected(Boolean(res?.ok));
        void load(); // resync after (re)connect
      });
      socket.on("disconnect", () => setConnected(false));
      socket.on("order.created", (order: KdsOrder) => {
        setOrders((current) => mergeOrder(current, order));
        beep();
      });
      socket.on("order.updated", (order: KdsOrder) => {
        setOrders((current) => mergeOrder(current, order));
      });
    }

    void connect();
    return () => {
      disposed = true;
      socketRef.current?.disconnect();
    };
  }, [branchId, load]);

  async function advance(order: KdsOrder) {
    const next = NEXT_ACTION[order.status];
    if (!next) return;
    // Optimistic update; realtime event will confirm.
    setOrders((current) => mergeOrder(current, { ...order, status: next }));
    await post(`/orders/${order.id}/status`, { status: next }).catch(() => load());
  }

  function orderLabel(order: KdsOrder): string {
    if (order.table) return t("board.table", { number: order.table.number });
    if (order.source === "qr") return t("board.qr");
    if (order.type === "delivery") return t("board.delivery");
    if (order.type === "takeaway") return t("board.takeaway");
    return t("board.walkin");
  }

  /** Distinguishing the order's channel by color helps the kitchen prioritize at a glance. */
  function orderBadgeVariant(order: KdsOrder): "default" | "destructive" | "success" {
    if (order.type === "delivery") return "destructive";
    if (order.type === "takeaway") return "success";
    return "default";
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b bg-card px-4 py-2">
        <div className="flex items-center gap-3">
          <img src="/logo-horizontal.png" alt="SpruVex R" className="h-8 object-contain" />
          <h1 className="text-lg font-bold">{t("app.title")}</h1>
          <Badge variant={connected ? "success" : "destructive"}>
            {connected ? t("board.connected") : t("board.disconnected")}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => i18n.changeLanguage(i18n.language === "ar" ? "en" : "ar")}
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

      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner className="h-10 w-10" />
        </div>
      ) : (
        <main className="grid flex-1 grid-cols-1 gap-3 p-3 md:grid-cols-3">
          {COLUMNS.map((column) => {
            const columnOrders = orders.filter((order) =>
              (column.statuses as readonly string[]).includes(order.status),
            );
            return (
              <section key={column.key} className="flex flex-col rounded-xl bg-muted/40 p-2">
                <h2 className="mb-2 flex items-center justify-between px-2 text-xl font-bold">
                  {t(`board.${column.key}`)}
                  <Badge>{columnOrders.length}</Badge>
                </h2>
                <div className="flex flex-1 flex-col gap-3 overflow-y-auto">
                  {columnOrders.length === 0 && (
                    <p className="p-4 text-center text-muted-foreground">{t("board.empty")}</p>
                  )}
                  {columnOrders.map((order) => {
                    const next = NEXT_ACTION[order.status];
                    return (
                      <Card key={order.id} className="border-2">
                        <CardContent className="space-y-2 p-3">
                          <div className="flex items-center justify-between">
                            <span className="text-2xl font-extrabold" dir="ltr">
                              #{order.orderNumber}
                            </span>
                            <div className="flex items-center gap-2">
                              <Badge variant={orderBadgeVariant(order)}>{orderLabel(order)}</Badge>
                              <ElapsedTimer createdAt={order.createdAt} />
                            </div>
                          </div>
                          <ul className="space-y-1.5">
                            {order.items.map((item) => (
                              <li key={item.id} className="border-b border-border/50 pb-1.5 last:border-0">
                                <div className="flex items-start gap-2 text-lg font-semibold leading-snug">
                                  <span className="text-primary" dir="ltr">
                                    {item.quantity}×
                                  </span>
                                  <span>
                                    {i18n.language === "en" && item.productSnapshot.nameEn
                                      ? item.productSnapshot.nameEn
                                      : item.productSnapshot.name}
                                  </span>
                                </div>
                                {item.modifiers.length > 0 && (
                                  <p className="ms-7 text-sm text-accent">
                                    {item.modifiers
                                      .map((modifier) =>
                                        i18n.language === "en" && modifier.modifierSnapshot.nameEn
                                          ? modifier.modifierSnapshot.nameEn
                                          : modifier.modifierSnapshot.name,
                                      )
                                      .join(" · ")}
                                  </p>
                                )}
                                {item.notes && (
                                  <p className="ms-7 text-sm text-amber-400">{item.notes}</p>
                                )}
                              </li>
                            ))}
                          </ul>
                          {order.notes && (
                            <p className="rounded bg-secondary p-2 text-sm">
                              {t("board.notes")}: {order.notes}
                            </p>
                          )}
                          {next && (
                            <Button size="lg" className="w-full text-lg" onClick={() => advance(order)}>
                              {t(`board.actions.${next}`)}
                            </Button>
                          )}
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </main>
      )}
    </div>
  );
}
