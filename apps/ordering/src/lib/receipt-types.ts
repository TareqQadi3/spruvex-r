export interface PublicReceipt {
  id: string;
  receiptNumber: number;
  vatRate: string;
  vatAmount: string;
  total: string;
  issuedAt: string;
  qrPayload: string | null;
  payload: {
    restaurant: {
      name: string;
      nameEn: string | null;
      legalName: string;
      vatNumber: string | null;
      crNumber: string | null;
      address: string | null;
      logoUrl: string | null;
      currency: string;
      receiptHeaderNote: string | null;
      receiptFooterNote: string | null;
    };
    branch: { name: string; nameEn: string | null; address: string | null; phone: string | null };
    order: {
      orderNumber: number;
      type: string;
      table: string | null;
      createdAt: string;
      lines: Array<{
        name: string;
        nameEn: string | null;
        quantity: number;
        unitPrice: string;
        lineTotal: string;
        modifiers: Array<{ name: string; priceAdjustment: string }>;
      }>;
    };
    totals: {
      subtotal: string;
      discount: string;
      vatRate: string;
      vatAmount: string;
      total: string;
    };
    payments: Array<{ method: string; amount: string; reference: string | null }>;
  };
}
