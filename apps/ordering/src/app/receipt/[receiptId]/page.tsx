import QRCode from "qrcode";
import { notFound } from "next/navigation";

import { apiGet, ApiError } from "@/lib/api";
import type { PublicReceipt } from "@/lib/receipt-types";

export const dynamic = "force-dynamic";

/**
 * Every string below comes from tenant-entered data (product/restaurant
 * names) frozen into the receipt snapshot — escape it before it lands in
 * this server-rendered page, or a malicious name becomes stored XSS.
 * React already escapes any value used as JSX text content, so this page
 * needs no manual escaping (unlike the POS's dangerouslySetInnerHTML
 * template) — this comment exists so a future edit doesn't introduce one.
 */

export default async function ReceiptPage({
  params,
}: {
  params: Promise<{ receiptId: string }>;
}) {
  const { receiptId } = await params;

  let receipt: PublicReceipt;
  try {
    receipt = await apiGet<PublicReceipt>(`/public/receipts/${receiptId}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      notFound();
    }
    throw error;
  }

  const { restaurant, branch, order, totals, payments } = receipt.payload;
  const qrDataUrl = receipt.qrPayload
    ? await QRCode.toDataURL(receipt.qrPayload, { width: 180, margin: 1 })
    : null;

  return (
    <main dir="rtl" lang="ar" className="mx-auto min-h-screen max-w-md bg-background px-4 py-8 text-foreground">
      <div className="rounded-xl border bg-card p-6 shadow-sm">
        {restaurant.logoUrl && (
          // Restaurant-provided URL — plain img avoids Next/Image remote-domain config per tenant.
          <img
            src={restaurant.logoUrl}
            alt=""
            className="mx-auto mb-3 h-14 w-14 rounded-full object-cover"
          />
        )}
        <h1 className="text-center text-lg font-bold">{restaurant.name}</h1>
        <p className="mt-1 text-center text-sm text-muted-foreground">
          {branch.name}
          {branch.address ? ` — ${branch.address}` : ""}
        </p>
        {restaurant.vatNumber && (
          <p className="text-center text-xs text-muted-foreground" dir="ltr">
            VAT: {restaurant.vatNumber}
          </p>
        )}
        {restaurant.receiptHeaderNote && (
          <p className="mt-2 text-center text-xs text-muted-foreground">{restaurant.receiptHeaderNote}</p>
        )}

        <div className="my-4 border-t border-dashed" />

        <div className="flex justify-between text-sm font-medium">
          <span>فاتورة رقم {receipt.receiptNumber}</span>
          <span dir="ltr">#{order.orderNumber}</span>
        </div>
        <p className="text-xs text-muted-foreground" dir="ltr">
          {new Date(receipt.issuedAt).toLocaleString("ar-SA")}
        </p>

        <div className="my-4 border-t border-dashed" />

        <div className="space-y-2">
          {order.lines.map((line, index) => (
            <div key={index} className="text-sm">
              <div className="flex justify-between">
                <span>
                  {line.quantity}× {line.name}
                </span>
                <span dir="ltr">{line.lineTotal}</span>
              </div>
              {line.modifiers.map((modifier, modifierIndex) => (
                <div key={modifierIndex} className="ps-4 text-xs text-muted-foreground">
                  + {modifier.name} <span dir="ltr">({modifier.priceAdjustment})</span>
                </div>
              ))}
            </div>
          ))}
        </div>

        <div className="my-4 border-t border-dashed" />

        <div className="space-y-1 text-sm">
          <div className="flex justify-between">
            <span>المجموع الفرعي</span>
            <span dir="ltr">{totals.subtotal}</span>
          </div>
          {Number(totals.discount) > 0 && (
            <div className="flex justify-between">
              <span>الخصم</span>
              <span dir="ltr">-{totals.discount}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span>ضريبة القيمة المضافة ({totals.vatRate}%)</span>
            <span dir="ltr">{totals.vatAmount}</span>
          </div>
          <div className="flex justify-between text-base font-bold">
            <span>الإجمالي</span>
            <span dir="ltr">
              {totals.total} {restaurant.currency}
            </span>
          </div>
        </div>

        <div className="my-4 border-t border-dashed" />

        <div className="space-y-1 text-sm text-muted-foreground">
          {payments.map((payment, index) => (
            <div key={index} className="flex justify-between">
              <span>{payment.method}</span>
              <span dir="ltr">{payment.amount}</span>
            </div>
          ))}
        </div>

        {qrDataUrl && (
          <div className="my-4 flex justify-center">
            {/* Server-generated data: URL, not a static asset — plain img is correct here. */}
            <img src={qrDataUrl} alt="ZATCA QR" width={150} height={150} />
          </div>
        )}

        <p className="text-center text-sm">شكرًا لطلبك</p>
        {restaurant.receiptFooterNote && (
          <p className="mt-2 text-center text-xs text-muted-foreground">{restaurant.receiptFooterNote}</p>
        )}
      </div>
    </main>
  );
}
