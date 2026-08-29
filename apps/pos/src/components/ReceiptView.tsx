import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button, Dialog, Spinner } from "@spruvex-r/ui";

import { posApi, type ReceiptData } from "../lib/pos-api";
import { printHtml } from "../lib/print";

/**
 * Every string below comes from tenant-entered data (product/branch/restaurant
 * names, VAT number) and is interpolated into HTML rendered via
 * dangerouslySetInnerHTML — escape it, or a malicious product/restaurant name
 * becomes stored XSS that runs in whoever's browser opens the receipt.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function receiptHtml(
  receipt: ReceiptData,
  qrDataUrl: string | null,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const p = receipt.payload;
  const lines = p.order.lines
    .map(
      (line) => `
      <div class="item">
        <div class="row"><span>${line.quantity}× ${escapeHtml(line.name)}</span><span dir="ltr">${escapeHtml(line.lineTotal)}</span></div>
        ${line.modifiers.map((m) => `<div class="mods">+ ${escapeHtml(m.name)} <span dir="ltr">(${escapeHtml(m.priceAdjustment)})</span></div>`).join("")}
      </div>`,
    )
    .join("");
  const payments = p.payments
    .map((payment) => `<div class="row muted"><span>${escapeHtml(t(`payment.${payment.method}`))}</span><span dir="ltr">${escapeHtml(payment.amount)}</span></div>`)
    .join("");

  return `
    <h1>${escapeHtml(p.restaurant.name)}</h1>
    <p class="center muted">${escapeHtml(p.branch.name)}${p.branch.address ? ` — ${escapeHtml(p.branch.address)}` : ""}</p>
    ${p.restaurant.vatNumber ? `<p class="center muted">${escapeHtml(t("receipt.vatNumber"))}: <span dir="ltr">${escapeHtml(p.restaurant.vatNumber)}</span></p>` : ""}
    <div class="line"></div>
    <div class="row"><span>${escapeHtml(t("receipt.title", { number: receipt.receiptNumber }))}</span><span dir="ltr">#${p.order.orderNumber}</span></div>
    <p class="muted" dir="ltr">${new Date(receipt.issuedAt).toLocaleString()}</p>
    ${p.order.table ? `<p class="muted">${escapeHtml(p.order.table)}</p>` : ""}
    <div class="line"></div>
    ${lines}
    <div class="line"></div>
    <div class="row"><span>${escapeHtml(t("receipt.subtotal"))}</span><span dir="ltr">${escapeHtml(p.totals.subtotal)}</span></div>
    ${Number(p.totals.discount) > 0 ? `<div class="row"><span>${escapeHtml(t("receipt.discount"))}</span><span dir="ltr">-${escapeHtml(p.totals.discount)}</span></div>` : ""}
    <div class="row"><span>${escapeHtml(t("receipt.vat", { rate: p.totals.vatRate }))}</span><span dir="ltr">${escapeHtml(p.totals.vatAmount)}</span></div>
    <div class="row big"><span>${escapeHtml(t("receipt.total"))}</span><span dir="ltr">${escapeHtml(p.totals.total)} ${escapeHtml(p.restaurant.currency)}</span></div>
    <div class="line"></div>
    ${payments}
    <div class="line"></div>
    ${qrDataUrl ? `<div class="center"><img src="${qrDataUrl}" alt="ZATCA QR" width="150" height="150" /></div>` : ""}
    <p class="center">${escapeHtml(t("receipt.thanks"))}</p>`;
}

export function ReceiptView({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    void posApi.receipt(orderId).then(async (data) => {
      setReceipt(data);
      if (data.qrPayload) {
        setQrDataUrl(await QRCode.toDataURL(data.qrPayload, { width: 150, margin: 1 }));
      }
    });
  }, [orderId]);

  return (
    <Dialog
      open
      onClose={onClose}
      title={receipt ? t("receipt.title", { number: receipt.receiptNumber }) : undefined}
    >
      {!receipt ? (
        <Spinner />
      ) : (
        <div className="space-y-4">
          <div
            className="mx-auto max-w-xs rounded-lg border bg-white p-4 text-sm text-black"
            dangerouslySetInnerHTML={{ __html: receiptHtml(receipt, qrDataUrl, t) }}
          />
          <div className="flex gap-2">
            <Button
              className="flex-1"
              onClick={() =>
                printHtml(
                  t("receipt.title", { number: receipt.receiptNumber }),
                  receiptHtml(receipt, qrDataUrl, t),
                )
              }
            >
              {t("receipt.print")}
            </Button>
            <Button variant="outline" className="flex-1" onClick={onClose}>
              {t("receipt.newOrder")}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
