import { buildUblXml, numberLines } from "./ubl-invoice";
import { hashXml } from "./hash-chain";

const baseInput = {
  kind: "invoice" as const,
  documentUuid: "11111111-1111-1111-1111-111111111111",
  documentNumber: 42,
  issueDateTime: new Date("2026-08-01T10:00:00.000Z"),
  currency: "SAR",
  seller: {
    name: "مطعم الاختبار",
    vatNumber: "300000000000003",
    crNumber: "1010101010",
    address: "الرياض",
  },
  lines: numberLines([
    {
      nameAr: "برجر",
      nameEn: "Burger",
      quantity: 2,
      unitPriceExclVat: "20.00",
      lineExtensionAmount: "40.00",
      vatRate: "15.00",
      vatAmount: "6.00",
    },
    {
      nameAr: "عصير",
      quantity: 1,
      unitPriceExclVat: "10.00",
      lineExtensionAmount: "10.00",
      vatRate: "15.00",
      vatAmount: "1.50",
    },
  ]),
  subtotal: "50.00",
  vatRate: "15.00",
  vatAmount: "7.50",
  total: "57.50",
  qrPayload: "QVFVSQ==",
  previousInvoiceHash: "0".repeat(64),
};

describe("ZATCA Phase 2 UBL 2.1 XML", () => {
  it("numbers lines sequentially starting from 1", () => {
    expect(baseInput.lines.map((l) => l.lineId)).toEqual([1, 2]);
  });

  it("produces well-formed, deterministic XML for the same input", () => {
    const xml1 = buildUblXml(baseInput);
    const xml2 = buildUblXml(baseInput);
    expect(xml1).toBe(xml2);
    expect(xml1.startsWith("<?xml")).toBe(true);
    expect(xml1).toContain("<Invoice ");
    expect(xml1).toContain("</Invoice>");
  });

  it("escapes text content so no field can break out into markup", () => {
    const xml = buildUblXml({
      ...baseInput,
      seller: { ...baseInput.seller, name: `مطعم <script>&"'` },
    });
    expect(xml).toContain("&lt;script&gt;&amp;&quot;&apos;");
    expect(xml).not.toContain("<script>");
  });

  it("omits the buyer block for a Simplified (B2C) invoice", () => {
    const xml = buildUblXml(baseInput);
    expect(xml).not.toContain("AccountingCustomerParty");
  });

  it("includes the buyer block for a Standard (B2B) invoice", () => {
    const xml = buildUblXml({ ...baseInput, buyer: { name: "شركة المثال", vatNumber: "300000000000099" } });
    expect(xml).toContain("AccountingCustomerParty");
    expect(xml).toContain("300000000000099");
  });

  it("references the preceding invoice UUID on a credit note", () => {
    const xml = buildUblXml({
      ...baseInput,
      kind: "credit_note",
      precedingDocumentUuid: baseInput.documentUuid,
    });
    expect(xml).toContain("<CreditNote ");
    expect(xml).toContain("BillingReference");
    expect(xml).toContain(baseInput.documentUuid);
  });

  it("hashes to different digests for different content, same digest for identical content", () => {
    const xml = buildUblXml(baseInput);
    const changed = buildUblXml({ ...baseInput, total: "99.99" });
    expect(hashXml(xml).toString("hex")).toBe(hashXml(buildUblXml(baseInput)).toString("hex"));
    expect(hashXml(xml).toString("hex")).not.toBe(hashXml(changed).toString("hex"));
  });
});
