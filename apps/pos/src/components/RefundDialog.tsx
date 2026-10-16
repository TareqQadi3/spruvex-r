import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Dialog, Input, Label, Spinner, cn } from "@spruvex-r/ui";

import { ApiError } from "../lib/api";
import { posApi } from "../lib/pos-api";

export function RefundDialog({
  orderId,
  maxAmount,
  onClose,
  onRefunded,
}: {
  orderId: string;
  /** Receipt total — the largest amount that can be refunded in one go. */
  maxAmount: string;
  onClose: () => void;
  onRefunded: () => void;
}) {
  const { t } = useTranslation();
  const [method, setMethod] = useState<"cash" | "card">("cash");
  const [amount, setAmount] = useState(maxAmount);
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!amount || Number(amount) <= 0) {
      setError(t("refund.amountRequired"));
      return;
    }
    if (!reason.trim()) {
      setError(t("refund.reasonRequired"));
      return;
    }
    setBusy(true);
    try {
      await posApi.refund(orderId, {
        amount,
        method,
        reason,
        ...(reference ? { reference } : {}),
      });
      onRefunded();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("refund.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title={t("refund.title")}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert variant="destructive">{error}</Alert>}
        <div className="flex gap-2">
          {(["cash", "card"] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={cn(
                "flex-1 rounded-lg border-2 py-2 font-medium transition-colors",
                method === option
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-card",
              )}
              onClick={() => setMethod(option)}
            >
              {t(`refund.${option}`)}
            </button>
          ))}
        </div>
        <div className="space-y-2">
          <Label htmlFor="refund-amount">{t("refund.amount")}</Label>
          <Input
            id="refund-amount"
            dir="ltr"
            inputMode="decimal"
            required
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="refund-reason">{t("refund.reason")}</Label>
          <Input
            id="refund-reason"
            required
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        {method === "card" && (
          <div className="space-y-2">
            <Label htmlFor="refund-reference">{t("refund.reference")}</Label>
            <Input
              id="refund-reference"
              dir="ltr"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </div>
        )}
        <div className="flex gap-2">
          <Button type="submit" className="flex-1" disabled={busy}>
            {busy ? <Spinner className="border-primary-foreground" /> : t("refund.submit")}
          </Button>
          <Button type="button" variant="outline" className="flex-1" onClick={onClose} disabled={busy}>
            {t("refund.cancel")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
