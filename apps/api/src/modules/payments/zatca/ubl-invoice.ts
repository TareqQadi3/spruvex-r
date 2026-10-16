/**
 * ZATCA Phase 2 — UBL 2.1 XML invoice generation.
 *
 * Builds the canonical XML ZATCA expects for Simplified (B2C) and Standard
 * (B2B) invoices, credit notes and debit notes. This module only ever
 * *generates* XML from data this service already trusts (never parses
 * externally-supplied XML), so there is no XXE surface here by construction.
 *
 * This is a structural implementation of the documented UBL 2.1 + ZATCA
 * extension shape (see erp-pos-saas-architect/references/zatca.md) — it has
 * not been validated against ZATCA's actual XSD/business-rule validator
 * (no sandbox account/credentials are available to this build). Treat the
 * element set here as the foundation to refine once real onboarding starts,
 * not as a certified-correct implementation.
 */

export type ZatcaDocumentKind = "invoice" | "credit_note" | "debit_note";

export interface UblInvoiceLine {
  /** Sequential, starting from 1 — ZATCA rejects gaps/out-of-order IDs. */
  lineId: number;
  nameAr: string;
  nameEn?: string | null;
  quantity: number;
  /** Unit price excluding VAT, SAR decimal string. */
  unitPriceExclVat: string;
  /** Line total excluding VAT, SAR decimal string. */
  lineExtensionAmount: string;
  vatRate: string;
  vatAmount: string;
}

export interface UblInvoiceInput {
  kind: ZatcaDocumentKind;
  documentUuid: string;
  /** Sequential document number, e.g. the branch's receiptNumber/creditNoteNumber. */
  documentNumber: number;
  issueDateTime: Date;
  currency: string;

  seller: {
    name: string;
    vatNumber: string;
    crNumber?: string | null;
    address?: string | null;
  };

  /** Present only for a Standard (B2B) document — Simplified (B2C) omits the buyer. */
  buyer?: {
    name: string;
    vatNumber?: string | null;
  } | null;

  /** For a credit/debit note: the invoice UUID it corrects. */
  precedingDocumentUuid?: string | null;

  lines: UblInvoiceLine[];

  subtotal: string;
  vatRate: string;
  vatAmount: string;
  total: string;

  /** Base64 TLV QR payload — embedded as an AdditionalDocumentReference. */
  qrPayload: string;
  /** Hex-encoded SHA-256 of the *previous* document in this branch's chain. */
  previousInvoiceHash: string;
}

/** XML 1.0 text-node escaping — the only defense this module needs against injection, since every value here is our own data, never parsed back as markup. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * ZATCA's 7-digit InvoiceTypeCode "name" attribute bitmask:
 * position 1 = invoice subtype (3rd-party billing/nominal/export/summary —
 * unused here, always 0), positions 2 = self-billing (0), 3 = summary (0),
 * ... simplified per the reference doc to the two bits this system actually
 * needs: standard vs simplified, and invoice vs credit/debit note is
 * expressed via the UBL document root element, not this code.
 */
function invoiceTypeName(isStandard: boolean): string {
  return `0${isStandard ? "1" : "2"}00000`;
}

const ROOT_ELEMENT: Record<ZatcaDocumentKind, string> = {
  invoice: "Invoice",
  credit_note: "CreditNote",
  debit_note: "DebitNote",
};

const DOCUMENT_TYPE_CODE: Record<ZatcaDocumentKind, string> = {
  invoice: "388",
  credit_note: "381",
  debit_note: "383",
};

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function isoTime(d: Date): string {
  return d.toISOString().slice(11, 19);
}

function buildLine(line: UblInvoiceLine): string {
  return `
  <cac:InvoiceLine>
    <cbc:ID>${line.lineId}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="PCE">${line.quantity}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="SAR">${line.lineExtensionAmount}</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="SAR">${line.vatAmount}</cbc:TaxAmount>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Name>${xmlEscape(line.nameAr)}</cbc:Name>
      ${line.nameEn ? `<cbc:Description>${xmlEscape(line.nameEn)}</cbc:Description>` : ""}
      <cac:ClassifiedTaxCategory>
        <cbc:ID>S</cbc:ID>
        <cbc:Percent>${line.vatRate}</cbc:Percent>
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="SAR">${line.unitPriceExclVat}</cbc:PriceAmount>
    </cac:Price>
  </cac:InvoiceLine>`;
}

/** Builds the canonical UBL 2.1 XML for one document. Deterministic — same input always produces the same bytes, which is what the hash chain signs over. */
export function buildUblXml(input: UblInvoiceInput): string {
  const root = ROOT_ELEMENT[input.kind];
  const typeName = invoiceTypeName(Boolean(input.buyer));

  const precedingDocRef = input.precedingDocumentUuid
    ? `
  <cac:BillingReference>
    <cac:InvoiceDocumentReference>
      <cbc:ID>${xmlEscape(input.precedingDocumentUuid)}</cbc:ID>
    </cac:InvoiceDocumentReference>
  </cac:BillingReference>`
    : "";

  const buyerBlock = input.buyer
    ? `
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${xmlEscape(input.buyer.vatNumber ?? "")}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${xmlEscape(input.buyer.name)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<${root} xmlns="urn:oasis:names:specification:ubl:schema:xsd:${root}-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:ID>${input.documentNumber}</cbc:ID>
  <cbc:UUID>${xmlEscape(input.documentUuid)}</cbc:UUID>
  <cbc:IssueDate>${isoDate(input.issueDateTime)}</cbc:IssueDate>
  <cbc:IssueTime>${isoTime(input.issueDateTime)}</cbc:IssueTime>
  <cbc:InvoiceTypeCode name="${typeName}">${DOCUMENT_TYPE_CODE[input.kind]}</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>${xmlEscape(input.currency)}</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>${xmlEscape(input.currency)}</cbc:TaxCurrencyCode>${precedingDocRef}
  <cac:AdditionalDocumentReference>
    <cbc:ID>QR</cbc:ID>
    <cac:Attachment>
      <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${input.qrPayload}</cbc:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>
  <cac:AdditionalDocumentReference>
    <cbc:ID>PIH</cbc:ID>
    <cac:Attachment>
      <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${xmlEscape(input.previousInvoiceHash)}</cbc:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${xmlEscape(input.seller.vatNumber)}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${xmlEscape(input.seller.name)}</cbc:RegistrationName>
        ${input.seller.crNumber ? `<cbc:CompanyID>${xmlEscape(input.seller.crNumber)}</cbc:CompanyID>` : ""}
      </cac:PartyLegalEntity>
      ${input.seller.address ? `<cac:PostalAddress><cbc:StreetName>${xmlEscape(input.seller.address)}</cbc:StreetName><cac:Country><cbc:IdentificationCode>SA</cbc:IdentificationCode></cac:Country></cac:PostalAddress>` : ""}
    </cac:Party>
  </cac:AccountingSupplierParty>${buyerBlock}
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="SAR">${input.vatAmount}</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="SAR">${input.subtotal}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="SAR">${input.vatAmount}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID>S</cbc:ID>
        <cbc:Percent>${input.vatRate}</cbc:Percent>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="SAR">${input.subtotal}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="SAR">${input.subtotal}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="SAR">${input.total}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="SAR">${input.total}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>${input.lines.map(buildLine).join("")}
</${root}>
`;
}

/** Enough to satisfy "sequential line IDs starting at 1" without callers hand-numbering. */
export function numberLines(
  lines: Omit<UblInvoiceLine, "lineId">[],
): UblInvoiceLine[] {
  return lines.map((line, index) => ({ ...line, lineId: index + 1 }));
}
