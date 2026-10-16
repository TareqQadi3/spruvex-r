import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button, Dialog, Spinner } from "@spruvex-r/ui";
// Namespace import — see packages/ui/src/apply-theme.ts for why a named
// import of a const re-exported through @spruvex-r/types' barrel file
// breaks Vite/Rollup's static CJS-interop analysis.
import * as SpruvexTypes from "@spruvex-r/types";

import { posApi, type ReceiptData } from "../lib/pos-api";
import { printHtml } from "../lib/print";
import { RefundDialog } from "./RefundDialog";

const { THEME_PRESETS, DEFAULT_THEME_COLOR } = SpruvexTypes;

const LOGO_SIZE_PX: Record<string, number> = { small: 32, medium: 48, large: 64 };

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

/**
 * The three printed-receipt templates (classic/modern/minimal) only ever
 * change spacing/color/font-size — never structure — via this scoped
 * stylesheet. Shared by both the on-screen dialog preview and the actual
 * print window (print.ts's own <style> block only carries page-width/
 * @media-print concerns, not these visual rules).
 */
function receiptStyles(template: string, accentHsl: string): string {
  const base = `
    .spx-receipt { font-family: "IBM Plex Sans Arabic", "Inter", system-ui, sans-serif; color: #000; }
    .spx-receipt .center { text-align: center; }
    .spx-receipt .muted { color: #444; }
    .spx-receipt .row { display: flex; justify-content: space-between; gap: 4px; }
    .spx-receipt .item { margin-bottom: 1.5mm; }
    .spx-receipt .mods { padding-inline-start: 6mm; color: #333; }
    .spx-receipt .big { font-weight: 700; }
    .spx-receipt .logo { display: block; margin: 0 auto 2mm; object-fit: contain; }
    .spx-receipt .logo.start { margin-inline-start: 0; margin-inline-end: auto; }`;

  if (template === "modern") {
    return `${base}
      .spx-receipt { font-size: 12px; }
      .spx-receipt h1 { font-size: 20px; font-weight: 800; text-align: center; margin-bottom: 1mm; }
      .spx-receipt .muted { font-size: 10px; }
      .spx-receipt .accent-bar { height: 2mm; background: hsl(${accentHsl}); border-radius: 1mm; margin: 2mm 0; }
      .spx-receipt .line { border-top: 1px solid #ddd; margin: 2mm 0; }
      .spx-receipt .big { font-size: 15px; color: hsl(${accentHsl}); }`;
  }
  if (template === "minimal") {
    return `${base}
      .spx-receipt { font-size: 11px; }
      .spx-receipt h1 { font-size: 14px; font-weight: 600; text-align: center; margin-bottom: 0.5mm; }
      .spx-receipt .muted { font-size: 9px; }
      .spx-receipt .accent-bar { display: none; }
      .spx-receipt .line { border-top: 1px dashed #999; margin: 1mm 0; }
      .spx-receipt .item { margin-bottom: 0.5mm; }
      .spx-receipt .big { font-size: 12px; }`;
  }
  // classic (default)
  return `${base}
    .spx-receipt { font-size: 12px; }
    .spx-receipt h1 { font-size: 16px; font-weight: 600; text-align: center; margin-bottom: 2mm; }
    .spx-receipt .muted { font-size: 10px; }
    .spx-receipt .accent-bar { display: none; }
    .spx-receipt .line { border-top: 1px dashed #000; margin: 2mm 0; }
    .spx-receipt .big { font-size: 14px; }`;
}

function receiptHtml(
  receipt: ReceiptData,
  qrDataUrl: string | null,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const p = receipt.payload;
  const template = p.restaurant.receiptTemplate || "classic";
  const preset = THEME_PRESETS[p.restaurant.themeColor as keyof typeof THEME_PRESETS] ?? THEME_PRESETS[DEFAULT_THEME_COLOR];
  const logoSizePx = LOGO_SIZE_PX[p.restaurant.receiptLogoSize] ?? LOGO_SIZE_PX.medium;
  const logoPosition = p.restaurant.receiptLogoPosition || "top-center";

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
    <style>${receiptStyles(template, preset.primary)}</style>
    <div class="spx-receipt">
    ${
      logoPosition !== "none" && p.restaurant.logoUrl
        ? `<img class="logo${logoPosition === "top-start" ? " start" : ""}" src="${escapeHtml(p.restaurant.logoUrl)}" alt="" width="${logoSizePx}" height="${logoSizePx}" />`
        : ""
    }
    <h1>${escapeHtml(p.restaurant.name)}</h1>
    <p class="center muted">${escapeHtml(p.branch.name)}${p.branch.address ? ` — ${escapeHtml(p.branch.address)}` : ""}</p>
    ${p.restaurant.vatNumber ? `<p class="center muted">${escapeHtml(t("receipt.vatNumber"))}: <span dir="ltr">${escapeHtml(p.restaurant.vatNumber)}</span></p>` : ""}
    ${p.restaurant.receiptHeaderNote ? `<p class="center muted">${escapeHtml(p.restaurant.receiptHeaderNote)}</p>` : ""}
    <div class="accent-bar"></div>
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
    <p class="center">${escapeHtml(t("receipt.thanks"))}</p>
    ${p.restaurant.receiptFooterNote ? `<p class="center muted">${escapeHtml(p.restaurant.receiptFooterNote)}</p>` : ""}
    </div>`;
}

export function ReceiptView({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  // Mutually exclusive with the receipt Dialog below — never render both at
  // once (two stacked focus-trapping dialogs would fight over Tab/Escape).
  const [refunding, setRefunding] = useState(false);

  useEffect(() => {
    void posApi.receipt(orderId).then(async (data) => {
      setReceipt(data);
      if (data.qrPayload) {
        setQrDataUrl(await QRCode.toDataURL(data.qrPayload, { width: 150, margin: 1 }));
      }
    });
  }, [orderId]);

  if (refunding && receipt) {
    return (
      <RefundDialog
        orderId={orderId}
        maxAmount={receipt.total}
        onClose={() => setRefunding(false)}
        onRefunded={() => {
          setRefunding(false);
          onClose();
        }}
      />
    );
  }

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
          <Button variant="ghost" className="w-full" onClick={() => setRefunding(true)}>
            {t("receipt.refund")}
          </Button>
        </div>
      )}
    </Dialog>
  );
}
