"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { io, type Socket } from "socket.io-client";

import { Badge, Button, Card, CardContent } from "@spruvex-r/ui";

import { useLocale, useLocalizedField } from "@/components/LocaleProvider";
import { clientGet } from "@/lib/client-api";
import { formatMoney } from "@/lib/money";
import type { TrackedOrder } from "@/lib/types";

/** Set by TableCartClient right after a successful submit, keyed by the
 * resulting orderId — best-effort only, purely to bold "your items" on a
 * shared table bill. A device that never ordered here (or cleared storage)
 * just sees no highlighting, which is harmless. */
function myPhoneStorageKey(orderId: string): string {
  return `spruvex:ordering:my-phone:order:${orderId}`;
}

const STEPS = ["new", "confirmed", "preparing", "ready", "served"] as const;
const STEP_INDEX: Record<string, number> = Object.fromEntries(
  STEPS.map((s, i) => [s, i]),
);

interface GuestStatusEvent {
  id: string;
  orderNumber: number;
  status: string;
  total: string;
  createdAt: string;
}

export function OrderTrackerClient({
  orderId,
  initialOrder,
  publicApiOrigin,
}: {
  orderId: string;
  initialOrder: TrackedOrder;
  publicApiOrigin: string;
}) {
  const { t, locale } = useLocale();
  const name = useLocalizedField();
  const router = useRouter();
  const [order, setOrder] = useState(initialOrder);
  const [live, setLive] = useState(false);
  const [myPhone, setMyPhone] = useState<string | null>(null);

  useEffect(() => {
    try {
      setMyPhone(localStorage.getItem(myPhoneStorageKey(orderId)));
    } catch {
      setMyPhone(null);
    }
  }, [orderId]);

  useEffect(() => {
    const socket: Socket = io(publicApiOrigin, { transports: ["websocket"] });

    socket.on("connect", async () => {
      const res = await socket.emitWithAck("subscribe", { channel: "order", orderId });
      setLive(Boolean(res?.ok));
    });
    socket.on("disconnect", () => setLive(false));
    socket.on("order.status", async (event: GuestStatusEvent) => {
      if (event.id !== orderId) return;
      // The socket payload is trimmed to {status,total} — a shared table's
      // order can also gain new ITEMS (another participant's round), which
      // this event never carries, so re-fetch the full order on any update
      // rather than trusting the trimmed fields alone.
      try {
        setOrder(await clientGet<TrackedOrder>(`/public/orders/${orderId}/track`));
        return;
      } catch {
        // fall through to the trimmed update below
      }
      setOrder((current) => ({ ...current, status: event.status, total: event.total }));
    });

    return () => {
      socket.disconnect();
    };
  }, [orderId, publicApiOrigin]);

  const cancelled = order.status === "cancelled";
  const completed = order.status === "completed";
  const currentIndex = STEP_INDEX[order.status] ?? (completed ? STEPS.length - 1 : -1);

  return (
    <div className="mx-auto max-w-lg space-y-5 p-4">
      <header className="flex items-center gap-2 pt-2">
        {order.restaurant.logoUrl ? (
          <img
            src={order.restaurant.logoUrl}
            alt={order.restaurant.name}
            className="h-9 w-9 rounded-full object-cover"
          />
        ) : null}
        <h1 className="text-lg font-bold">
          {locale === "en" && order.restaurant.nameEn
            ? order.restaurant.nameEn
            : order.restaurant.name}
        </h1>
      </header>

      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex items-center justify-between">
            <span className="text-xl font-extrabold" dir="ltr">
              #{order.orderNumber}
            </span>
            <Badge variant={live ? "success" : "muted"}>
              {live ? t("track.liveUpdates") : "…"}
            </Badge>
          </div>

          <p className="text-center text-lg font-semibold text-primary">
            {t(`track.status.${cancelled ? "cancelled" : completed ? "completed" : order.status}`)}
          </p>

          {!cancelled && (
            <div className="flex items-center justify-between">
              {STEPS.map((step, index) => (
                <div key={step} className="flex flex-1 flex-col items-center gap-1">
                  <div
                    className={`h-3 w-3 rounded-full ${
                      index <= currentIndex || completed ? "bg-primary" : "bg-muted"
                    }`}
                  />
                  <span className="text-[10px] text-muted-foreground">
                    {t(`track.steps.${step}`)}
                  </span>
                </div>
              ))}
            </div>
          )}

          {(() => {
            const isShared = order.items.some((item) => item.participantPhone);
            const mine = isShared && myPhone
              ? order.items.filter((item) => item.participantPhone === myPhone)
              : [];
            const others = isShared && myPhone
              ? order.items.filter((item) => item.participantPhone !== myPhone)
              : order.items;
            const renderLine = (item: (typeof order.items)[number], index: number) => (
              <div key={index} className="flex justify-between text-sm">
                <span>
                  {item.quantity}× {name({ name: item.name, nameEn: item.nameEn })}
                </span>
              </div>
            );
            return (
              <div className="space-y-3 border-t pt-3">
                {mine.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs font-semibold text-primary">{t("track.yourItems")}</p>
                    {mine.map(renderLine)}
                  </div>
                )}
                {others.length > 0 && (
                  <div className="space-y-1">
                    {mine.length > 0 && (
                      <p className="text-xs font-semibold text-muted-foreground">{t("track.otherItems")}</p>
                    )}
                    {others.map(renderLine)}
                  </div>
                )}
              </div>
            );
          })()}

          <div className="flex justify-between border-t pt-3 font-bold">
            <span>{t("cart.total")}</span>
            <span dir="ltr">{formatMoney(order.total, order.restaurant.currency)}</span>
          </div>
        </CardContent>
      </Card>

      {order.table && (
        <div className="space-y-3 text-center">
          <p className="text-sm text-muted-foreground">{order.table}</p>
          <p className="text-xs text-muted-foreground">{t("track.tableNotice")}</p>
          {!cancelled && (
            <Button variant="outline" className="w-full" onClick={() => router.back()}>
              {t("track.orderMore")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
