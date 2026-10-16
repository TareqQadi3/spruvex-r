import { Injectable, NotFoundException } from "@nestjs/common";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

import { halalasToSar, sarToHalalas } from "../../shared/common/money";
import { PrismaService } from "../../shared/prisma/prisma.service";
import { resolveRange } from "./report-utils";

export type VatReturnResult = Awaited<ReturnType<VatReturnService["vatReturn"]>>;

export interface VatReturnLineItem {
  type: "sale" | "credit_note" | "debit_note" | "purchase";
  branchName: string;
  branchNameEn: string | null;
  /** Receipt/credit-note/debit-note number (ZATCA-style sequencing) for sales-side
   * lines; the SUPPLIER's own invoice number (a string, not our sequencing) for a
   * "purchase" line — still the accountant's trail back to the source document. */
  documentNumber: number | string;
  /** For a credit/debit note: the receipt number of the original invoice it adjusts. */
  referenceReceiptNumber: number | null;
  orderNumber: number | null;
  /** "purchase" lines only — who the invoice was billed by. */
  supplierName?: string;
  supplierNameEn?: string | null;
  issuedAt: Date;
  vatRatePercent: string;
  netAmount: string;
  vatAmount: string;
  total: string;
}

export interface VatReturnRateBucket {
  vatRatePercent: string;
  salesNet: string;
  salesVat: string;
  salesCount: number;
  creditNoteNet: string;
  creditNoteVat: string;
  creditNoteCount: number;
  debitNoteNet: string;
  debitNoteVat: string;
  debitNoteCount: number;
  /** salesNet - creditNoteNet + debitNoteNet */
  netTaxableSales: string;
  /** salesVat - creditNoteVat + debitNoteVat */
  netVat: string;
}

/**
 * VAT return export — built ENTIRELY from real, already-issued documents on
 * the output side (Receipt/CreditNote/DebitNote) and real, CONFIRMED
 * PurchaseInvoice rows on the input side, never a separately re-estimated
 * figure. Read-only: touches no sale/payment/order/purchase-invoice pathway.
 *
 * Data-model facts that shape this report, documented here rather than
 * silently assumed away:
 *
 * 1. VAT registration is per-TENANT, not per-branch (Tenant.vatNumber is the
 *    only VAT-number field in the schema; Branch has none). A tenant's
 *    branches therefore file ONE consolidated return under one VAT number —
 *    this report defaults to combining all branches for exactly that reason,
 *    though a single branch can still be selected for internal analysis.
 *
 * 2. Input VAT is computed from PurchaseInvoice rows with status="confirmed"
 *    only, filtered by invoiceDate falling inside the requested period — a
 *    draft (not yet reviewed) or cancelled invoice never counts. This is
 *    necessarily only as complete as what's been entered: if a supplier
 *    invoice for the period hasn't been recorded and confirmed yet, it
 *    won't appear here (see the `inputTax.note` returned alongside the
 *    figure), same as any bookkeeping system reflects only what's been
 *    entered.
 */
@Injectable()
export class VatReturnService {
  constructor(private readonly prisma: PrismaService) {}

  async vatReturn(branchId: string | undefined, from: string | undefined, to: string | undefined) {
    const { start, end } = resolveRange(from, to);

    const tenant = await this.prisma.scoped.tenant.findFirst({
      where: { deletedAt: null },
      select: { name: true, nameEn: true, legalName: true, vatNumber: true, crNumber: true },
    });
    if (!tenant) {
      throw new NotFoundException("Tenant not found");
    }

    const branch = branchId
      ? await this.prisma.scoped.branch.findFirst({ where: { id: branchId }, select: { id: true, name: true, nameEn: true } })
      : null;
    if (branchId && !branch) {
      throw new NotFoundException("Branch not found");
    }

    const branchWhere = branchId ? { branchId } : {};

    // Receipt/CreditNote/DebitNote carry a branchId column but no declared
    // Prisma relation to Branch — resolve names via a lookup map instead of
    // a nested `select`.
    const branches = await this.prisma.scoped.branch.findMany({
      select: { id: true, name: true, nameEn: true },
    });
    const branchById = new Map(branches.map((b) => [b.id, b]));
    const branchNameOf = (id: string) => branchById.get(id) ?? { name: "?", nameEn: null };

    const [receipts, creditNotes, debitNotes, purchaseInvoices] = await Promise.all([
      this.prisma.scoped.receipt.findMany({
        where: { issuedAt: { gte: start, lte: end }, ...branchWhere },
        select: {
          receiptNumber: true,
          vatRate: true,
          vatAmount: true,
          total: true,
          issuedAt: true,
          branchId: true,
          order: { select: { orderNumber: true } },
        },
        orderBy: { issuedAt: "asc" },
      }),
      this.prisma.scoped.creditNote.findMany({
        where: { issuedAt: { gte: start, lte: end }, ...branchWhere },
        select: {
          creditNoteNumber: true,
          vatRate: true,
          vatAmount: true,
          total: true,
          issuedAt: true,
          branchId: true,
          receipt: { select: { receiptNumber: true } },
        },
        orderBy: { issuedAt: "asc" },
      }),
      this.prisma.scoped.debitNote.findMany({
        where: { issuedAt: { gte: start, lte: end }, ...branchWhere },
        select: {
          debitNoteNumber: true,
          vatRate: true,
          vatAmount: true,
          total: true,
          issuedAt: true,
          branchId: true,
          receipt: { select: { receiptNumber: true } },
        },
        orderBy: { issuedAt: "asc" },
      }),
      this.prisma.scoped.purchaseInvoice.findMany({
        where: { status: "confirmed", invoiceDate: { gte: start, lte: end }, ...branchWhere },
        select: {
          supplierInvoiceNumber: true,
          invoiceDate: true,
          subtotal: true,
          vatAmount: true,
          total: true,
          branchId: true,
          supplier: { select: { name: true, nameEn: true } },
        },
        orderBy: { invoiceDate: "asc" },
      }),
    ]);

    type Bucket = {
      salesNetHalalas: number;
      salesVatHalalas: number;
      salesCount: number;
      creditNoteNetHalalas: number;
      creditNoteVatHalalas: number;
      creditNoteCount: number;
      debitNoteNetHalalas: number;
      debitNoteVatHalalas: number;
      debitNoteCount: number;
    };
    const buckets = new Map<string, Bucket>();
    const emptyBucket = (): Bucket => ({
      salesNetHalalas: 0,
      salesVatHalalas: 0,
      salesCount: 0,
      creditNoteNetHalalas: 0,
      creditNoteVatHalalas: 0,
      creditNoteCount: 0,
      debitNoteNetHalalas: 0,
      debitNoteVatHalalas: 0,
      debitNoteCount: 0,
    });

    const lineItems: VatReturnLineItem[] = [];

    for (const r of receipts) {
      const totalHalalas = sarToHalalas(r.total.toString());
      const vatHalalas = sarToHalalas(r.vatAmount.toString());
      const netHalalas = totalHalalas - vatHalalas;
      const rateKey = r.vatRate.toString();
      const bucket = buckets.get(rateKey) ?? emptyBucket();
      bucket.salesNetHalalas += netHalalas;
      bucket.salesVatHalalas += vatHalalas;
      bucket.salesCount += 1;
      buckets.set(rateKey, bucket);

      lineItems.push({
        type: "sale",
        branchName: branchNameOf(r.branchId).name,
        branchNameEn: branchNameOf(r.branchId).nameEn,
        documentNumber: r.receiptNumber,
        referenceReceiptNumber: null,
        orderNumber: r.order?.orderNumber ?? null,
        issuedAt: r.issuedAt,
        vatRatePercent: rateKey,
        netAmount: halalasToSar(netHalalas),
        vatAmount: halalasToSar(vatHalalas),
        total: halalasToSar(totalHalalas),
      });
    }

    for (const cn of creditNotes) {
      const totalHalalas = sarToHalalas(cn.total.toString());
      const vatHalalas = sarToHalalas(cn.vatAmount.toString());
      const netHalalas = totalHalalas - vatHalalas;
      const rateKey = cn.vatRate.toString();
      const bucket = buckets.get(rateKey) ?? emptyBucket();
      bucket.creditNoteNetHalalas += netHalalas;
      bucket.creditNoteVatHalalas += vatHalalas;
      bucket.creditNoteCount += 1;
      buckets.set(rateKey, bucket);

      lineItems.push({
        type: "credit_note",
        branchName: branchNameOf(cn.branchId).name,
        branchNameEn: branchNameOf(cn.branchId).nameEn,
        documentNumber: cn.creditNoteNumber,
        referenceReceiptNumber: cn.receipt.receiptNumber,
        orderNumber: null,
        issuedAt: cn.issuedAt,
        vatRatePercent: rateKey,
        netAmount: halalasToSar(netHalalas),
        vatAmount: halalasToSar(vatHalalas),
        total: halalasToSar(totalHalalas),
      });
    }

    for (const dn of debitNotes) {
      const totalHalalas = sarToHalalas(dn.total.toString());
      const vatHalalas = sarToHalalas(dn.vatAmount.toString());
      const netHalalas = totalHalalas - vatHalalas;
      const rateKey = dn.vatRate.toString();
      const bucket = buckets.get(rateKey) ?? emptyBucket();
      bucket.debitNoteNetHalalas += netHalalas;
      bucket.debitNoteVatHalalas += vatHalalas;
      bucket.debitNoteCount += 1;
      buckets.set(rateKey, bucket);

      lineItems.push({
        type: "debit_note",
        branchName: branchNameOf(dn.branchId).name,
        branchNameEn: branchNameOf(dn.branchId).nameEn,
        documentNumber: dn.debitNoteNumber,
        referenceReceiptNumber: dn.receipt.receiptNumber,
        orderNumber: null,
        issuedAt: dn.issuedAt,
        vatRatePercent: rateKey,
        netAmount: halalasToSar(netHalalas),
        vatAmount: halalasToSar(vatHalalas),
        total: halalasToSar(totalHalalas),
      });
    }

    // Input tax: only CONFIRMED purchase invoices count (a draft hasn't been
    // reviewed yet; a cancelled one was withdrawn) — see the class doc
    // comment. Deliberately kept separate from the sales-side `byRate`
    // buckets above: a single supplier invoice can mix VAT rates across its
    // own lines, so folding it into the sales rate table would conflate two
    // different rate populations rather than clarify anything.
    let totalInputNetHalalas = 0;
    let totalInputVatHalalas = 0;
    for (const pi of purchaseInvoices) {
      const totalHalalas = sarToHalalas(pi.total.toString());
      const vatHalalas = sarToHalalas(pi.vatAmount.toString());
      const netHalalas = sarToHalalas(pi.subtotal.toString());
      totalInputNetHalalas += netHalalas;
      totalInputVatHalalas += vatHalalas;

      lineItems.push({
        type: "purchase",
        branchName: branchNameOf(pi.branchId).name,
        branchNameEn: branchNameOf(pi.branchId).nameEn,
        documentNumber: pi.supplierInvoiceNumber,
        referenceReceiptNumber: null,
        orderNumber: null,
        supplierName: pi.supplier.name,
        supplierNameEn: pi.supplier.nameEn,
        issuedAt: pi.invoiceDate,
        // Mixed-rate invoices have no single rate to report here — the per-line
        // rates live on PurchaseInvoiceItem, out of this summary's scope.
        vatRatePercent: "—",
        netAmount: halalasToSar(netHalalas),
        vatAmount: halalasToSar(vatHalalas),
        total: halalasToSar(totalHalalas),
      });
    }

    lineItems.sort((a, b) => a.issuedAt.getTime() - b.issuedAt.getTime());

    const byRate: VatReturnRateBucket[] = [...buckets.entries()]
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([rateKey, b]) => {
        const netTaxableHalalas = b.salesNetHalalas - b.creditNoteNetHalalas + b.debitNoteNetHalalas;
        const netVatHalalas = b.salesVatHalalas - b.creditNoteVatHalalas + b.debitNoteVatHalalas;
        return {
          vatRatePercent: rateKey,
          salesNet: halalasToSar(b.salesNetHalalas),
          salesVat: halalasToSar(b.salesVatHalalas),
          salesCount: b.salesCount,
          creditNoteNet: halalasToSar(b.creditNoteNetHalalas),
          creditNoteVat: halalasToSar(b.creditNoteVatHalalas),
          creditNoteCount: b.creditNoteCount,
          debitNoteNet: halalasToSar(b.debitNoteNetHalalas),
          debitNoteVat: halalasToSar(b.debitNoteVatHalalas),
          debitNoteCount: b.debitNoteCount,
          netTaxableSales: halalasToSar(netTaxableHalalas),
          netVat: halalasToSar(netVatHalalas),
        };
      });

    const totalNetTaxableHalalas = [...buckets.values()].reduce(
      (sum, b) => sum + (b.salesNetHalalas - b.creditNoteNetHalalas + b.debitNoteNetHalalas),
      0,
    );
    const totalOutputVatHalalas = [...buckets.values()].reduce(
      (sum, b) => sum + (b.salesVatHalalas - b.creditNoteVatHalalas + b.debitNoteVatHalalas),
      0,
    );

    const netVatDueHalalas = totalOutputVatHalalas - totalInputVatHalalas;

    return {
      tenant,
      branch,
      period: { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) },
      byRate,
      totals: {
        netTaxableSales: halalasToSar(totalNetTaxableHalalas),
        outputVat: halalasToSar(totalOutputVatHalalas),
      },
      inputTax: {
        supported: true,
        note:
          "محسوبة من فواتير المشتريات المؤكدة (Confirmed) فقط لهذه الفترة — تأكد من إدخال وتأكيد كل فواتير " +
          "الموردين قبل رفع الإقرار، فأي فاتورة غير مسجّلة أو ما زالت مسودة لن تُحتسب هنا.",
        netAmount: halalasToSar(totalInputNetHalalas),
        vatAmount: halalasToSar(totalInputVatHalalas),
        invoiceCount: purchaseInvoices.length,
      },
      /** outputVat - inputVat — negative means a refund position, not an amount owed. */
      netVatDue: halalasToSar(netVatDueHalalas),
      lineItems,
    };
  }

  /**
   * CSV export — opens directly in Excel. Three sections separated by a
   * blank line: return header, per-rate summary, then every source
   * document with its own number so the accountant can trace any figure
   * back to the exact receipt/credit-note/debit-note that produced it.
   */
  toCsv(result: VatReturnResult): string {
    const rows: string[][] = [];
    const typeLabel: Record<VatReturnLineItem["type"], string> = {
      sale: "مبيعات",
      credit_note: "إشعار دائن",
      debit_note: "إشعار مدين",
      purchase: "فاتورة مشتريات",
    };

    rows.push(["تقرير الإقرار الضريبي / VAT Return Export"]);
    rows.push(["الكيان / Entity", result.tenant.legalName ?? result.tenant.name]);
    rows.push(["الرقم الضريبي / VAT Number", result.tenant.vatNumber ?? ""]);
    rows.push(["السجل التجاري / CR Number", result.tenant.crNumber ?? ""]);
    rows.push(["الفرع / Branch", result.branch ? result.branch.name : "كل الفروع / All branches"]);
    rows.push(["الفترة / Period", `${result.period.from} → ${result.period.to}`]);
    rows.push([]);

    rows.push([
      "نسبة الضريبة / VAT Rate %",
      "صافي المبيعات / Sales Net",
      "ضريبة المخرجات / Sales VAT",
      "عدد الفواتير / Sales Count",
      "صافي إشعارات الدائن / Credit Note Net",
      "ضريبة إشعارات الدائن / Credit Note VAT",
      "عدد إشعارات الدائن / Credit Note Count",
      "صافي إشعارات المدين / Debit Note Net",
      "ضريبة إشعارات المدين / Debit Note VAT",
      "عدد إشعارات المدين / Debit Note Count",
      "صافي المبيعات الخاضعة / Net Taxable Sales",
      "صافي الضريبة / Net VAT",
    ]);
    for (const b of result.byRate) {
      rows.push([
        b.vatRatePercent,
        b.salesNet,
        b.salesVat,
        String(b.salesCount),
        b.creditNoteNet,
        b.creditNoteVat,
        String(b.creditNoteCount),
        b.debitNoteNet,
        b.debitNoteVat,
        String(b.debitNoteCount),
        b.netTaxableSales,
        b.netVat,
      ]);
    }
    rows.push([
      "الإجمالي / Total",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      result.totals.netTaxableSales,
      result.totals.outputVat,
    ]);
    rows.push([]);
    rows.push(["صافي ضريبة المدخلات / Input VAT Net Amount", result.inputTax.netAmount]);
    rows.push(["ضريبة المدخلات / Input VAT", result.inputTax.vatAmount]);
    rows.push(["عدد فواتير المشتريات المؤكدة / Confirmed Purchase Invoice Count", String(result.inputTax.invoiceCount)]);
    rows.push(["ملاحظة / Note", result.inputTax.note]);
    rows.push([
      "صافي الضريبة المستحقة (سالب = رصيد مسترد) / Net VAT Due (negative = refund position)",
      result.netVatDue,
    ]);
    rows.push([]);

    rows.push([
      "النوع / Type",
      "الفرع / Branch",
      "Branch (EN)",
      "رقم المستند / Document #",
      "مرجع الفاتورة الأصلية / Reference Receipt #",
      "رقم الطلب / Order #",
      "المورّد / Supplier",
      "التاريخ / Issued At",
      "نسبة الضريبة % / VAT Rate %",
      "صافي المبلغ / Net Amount",
      "مبلغ الضريبة / VAT Amount",
      "الإجمالي / Total",
    ]);
    for (const li of result.lineItems) {
      rows.push([
        typeLabel[li.type],
        li.branchName,
        li.branchNameEn ?? "",
        String(li.documentNumber),
        li.referenceReceiptNumber !== null ? String(li.referenceReceiptNumber) : "",
        li.orderNumber !== null ? String(li.orderNumber) : "",
        li.supplierName ?? "",
        li.issuedAt.toISOString(),
        li.vatRatePercent,
        li.netAmount,
        li.vatAmount,
        li.total,
      ]);
    }

    return rows.map((row) => row.map(csvEscape).join(",")).join("\r\n");
  }

  /** One-page PDF summary — the per-rate breakdown and grand totals only (line items belong in the CSV). */
  async toPdf(result: VatReturnResult): Promise<Buffer> {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.HelveticaBold);
    const fontLight = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([595.28, 841.89]);
    const marginX = 40;
    let y = 800;

    const title = "VAT Return Summary";
    page.drawText(title, { x: marginX, y, size: 18, font, color: rgb(0.18, 0.49, 0.2) });
    y -= 28;

    const line = (text: string, size = 11, useFont = fontLight) => {
      page.drawText(text, { x: marginX, y, size, font: useFont });
      y -= size + 8;
    };

    // Standard PDF fonts can't shape Arabic glyphs, so entity/branch names
    // here fall back to their English name (or the VAT number) rather than
    // ever drawing the Arabic name/legalName, which would throw at render
    // time. The CSV export carries the real Arabic name.
    line(`Entity: ${result.tenant.nameEn ?? result.tenant.vatNumber ?? "(see CSV for Arabic name)"}`);
    line(`VAT Number: ${result.tenant.vatNumber ?? "-"}`);
    line(`CR Number: ${result.tenant.crNumber ?? "-"}`);
    line(`Branch: ${result.branch ? (result.branch.nameEn ?? "(see CSV for Arabic name)") : "All branches"}`);
    line(`Period: ${result.period.from} to ${result.period.to}`);
    y -= 10;

    line("VAT Rate | Net Taxable Sales | Net VAT | Sales Count", 11, font);
    for (const b of result.byRate) {
      line(`${b.vatRatePercent}% | SAR ${b.netTaxableSales} | SAR ${b.netVat} | ${b.salesCount}`);
    }
    y -= 10;

    line(`Total Net Taxable Sales: SAR ${result.totals.netTaxableSales}`, 12, font);
    line(`Total Output VAT: SAR ${result.totals.outputVat}`, 12, font);
    y -= 4;

    // Standard PDF fonts can't shape Arabic glyphs, so the PDF summary stays
    // English-only; the CSV export carries the full bilingual note.
    line(`Input VAT (from ${result.inputTax.invoiceCount} confirmed purchase invoice(s)):`, 11, font);
    line(`  Net Amount: SAR ${result.inputTax.netAmount}   VAT: SAR ${result.inputTax.vatAmount}`, 11);
    const inputVatNoteEn =
      "Computed from CONFIRMED purchase invoices for this period only. Make sure every supplier " +
      "invoice for the period has been entered and confirmed — anything still draft or cancelled " +
      "is excluded. See the CSV export for the Arabic note.";
    for (const nl of wrapText(inputVatNoteEn, 90)) line(nl, 9);
    y -= 6;

    const netVatDueIsRefund = Number(result.netVatDue) < 0;
    line(
      `Net VAT Due: SAR ${result.netVatDue}${netVatDueIsRefund ? " (refund position)" : ""}`,
      13,
      font,
    );

    return Buffer.from(await pdf.save());
  }
}

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function wrapText(text: string, maxChars: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if ((current + " " + word).trim().length > maxChars) {
      if (current) lines.push(current.trim());
      current = word;
    } else {
      current = (current + " " + word).trim();
    }
  }
  if (current) lines.push(current.trim());
  return lines;
}
