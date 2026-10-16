import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Badge, Button, Card, CardContent, Dialog, Spinner, cn } from "@spruvex-r/ui";

import { ApiError } from "../lib/api";
import { posApi, type OpenSession, type SplitResult } from "../lib/pos-api";
import { PaymentDialog } from "../components/PaymentDialog";

const REFRESH_MS = 15000;

export function SessionsScreen({
  branchId,
  onAddItems,
}: {
  branchId: string;
  onAddItems: (tableId: string) => void;
}) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<OpenSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [splitting, setSplitting] = useState<OpenSession | null>(null);
  const [closeConfirm, setCloseConfirm] = useState<OpenSession | null>(null);

  const load = useCallback(async () => {
    try {
      setSessions(await posApi.listOpenSessions(branchId));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setLoading(false);
    }
  }, [branchId, t]);

  useEffect(() => {
    void load();
    const interval = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(interval);
  }, [load]);

  async function attemptClose(session: OpenSession, force: boolean) {
    try {
      await posApi.closeSession(session.table.id, force);
      setCloseConfirm(null);
      void load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && !force) {
        setCloseConfirm(session);
      } else {
        alert(e instanceof ApiError ? e.message : t("common.error"));
      }
    }
  }

  if (loading) return <Spinner className="m-8 h-8 w-8" />;

  return (
    <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 xl:grid-cols-3">
      {error && (
        <div className="col-span-full">
          <Alert variant="destructive">{error}</Alert>
        </div>
      )}
      {sessions.length === 0 && (
        <p className="col-span-full p-8 text-center text-muted-foreground">{t("sessions.empty")}</p>
      )}
      {sessions.map((session) => {
        const unpaid = Number(session.unpaidBalance) > 0;
        return (
          <Card key={session.sessionId}>
            <CardContent className="space-y-2 p-4">
              <div className="flex items-center justify-between">
                <span className="text-xl font-extrabold" dir="ltr">
                  {t("pos.table", { number: session.table.number })}
                </span>
                {session.staleFlaggedAt && (
                  <Badge variant="destructive">{t("sessions.stale")}</Badge>
                )}
              </div>

              <div className="flex flex-wrap gap-1">
                {session.participants.length === 0 && (
                  <span className="text-xs text-muted-foreground">{t("sessions.noParticipants")}</span>
                )}
                {session.participants.map((p) => (
                  <Badge key={p.phone} variant="muted" dir="ltr">
                    {p.name ? `${p.name} · ${p.phone}` : p.phone}
                  </Badge>
                ))}
              </div>

              {session.order ? (
                <div className="flex items-center justify-between border-t pt-2 text-sm">
                  <span dir="ltr">
                    #{session.order.orderNumber} — {t(`orders.status.${session.order.status}`)}
                  </span>
                  <span className="text-lg font-bold text-primary" dir="ltr">
                    {session.order.total} {t("pos.sar")}
                  </span>
                </div>
              ) : (
                <p className="border-t pt-2 text-sm text-muted-foreground">{t("sessions.noOrderYet")}</p>
              )}

              {unpaid && (
                <p className="text-sm font-semibold text-destructive" dir="ltr">
                  {t("sessions.unpaidBalance")}: {session.unpaidBalance} {t("pos.sar")}
                </p>
              )}

              <div className="flex flex-wrap gap-1 pt-1">
                <Button size="sm" onClick={() => onAddItems(session.table.id)}>
                  {t("sessions.addItems")}
                </Button>
                {session.order && unpaid && (
                  <Button size="sm" variant="secondary" onClick={() => setSplitting(session)}>
                    {t("sessions.splitAndPay")}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="text-destructive"
                  onClick={() => void attemptClose(session, false)}
                >
                  {t("sessions.close")}
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}

      {splitting && (
        <SplitDialog
          session={splitting}
          onClose={() => {
            setSplitting(null);
            void load();
          }}
        />
      )}

      <Dialog
        open={closeConfirm !== null}
        onClose={() => setCloseConfirm(null)}
        title={t("sessions.close")}
      >
        {closeConfirm && (
          <div className="space-y-4">
            <Alert variant="destructive">
              {t("sessions.unpaidCloseWarning", { amount: closeConfirm.unpaidBalance })}
            </Alert>
            <Button
              variant="destructive"
              className="w-full"
              onClick={() => void attemptClose(closeConfirm, true)}
            >
              {t("sessions.forceClose")}
            </Button>
          </div>
        )}
      </Dialog>
    </div>
  );
}

function SplitDialog({ session, onClose }: { session: OpenSession; onClose: () => void }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"equal" | "by_item">("equal");
  const [result, setResult] = useState<SplitResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState<{ label: string; amount: string } | null>(null);

  const load = useCallback(async () => {
    if (!session.order) return;
    try {
      setResult(await posApi.computeSplit(session.order.id, mode));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("common.error"));
    }
  }, [session.order, mode, t]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!session.order) return null;
  const order = session.order;

  return (
    <Dialog open onClose={onClose} title={t("sessions.splitTitle", { number: order.orderNumber })}>
      <div className="space-y-4">
        {error && <Alert variant="destructive">{error}</Alert>}

        <div className="flex gap-1 rounded-lg bg-muted p-1">
          {(["equal", "by_item"] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={cn(
                "flex-1 rounded-md px-3 py-1.5 text-sm font-medium",
                mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground",
              )}
              onClick={() => setMode(m)}
            >
              {t(`sessions.splitMode.${m}`)}
            </button>
          ))}
        </div>

        {!result ? (
          <Spinner className="m-4 h-6 w-6" />
        ) : (
          <div className="space-y-2">
            {result.participants.map((p, index) => (
              <div
                key={p.phone ?? index}
                className="flex items-center justify-between rounded-lg border p-3"
              >
                <span dir="ltr" className="text-sm">
                  {p.name ? `${p.name} · ${p.phone}` : (p.phone ?? t("sessions.sharedBucket"))}
                </span>
                <div className="flex items-center gap-2">
                  <span className="font-bold" dir="ltr">
                    {p.amount} {t("pos.sar")}
                  </span>
                  <Button
                    size="sm"
                    onClick={() =>
                      setPaying({ label: p.name ?? p.phone ?? t("sessions.sharedBucket"), amount: p.amount })
                    }
                  >
                    {t("payment.pay")}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {paying && (
        <PaymentDialog
          orderId={order.id}
          orderNumber={order.orderNumber}
          presetAmount={paying.amount}
          presetLabel={paying.label}
          onClose={() => {
            setPaying(null);
            void load();
          }}
          onCompleted={() => void load()}
        />
      )}
    </Dialog>
  );
}
