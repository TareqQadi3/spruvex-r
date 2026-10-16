import { createHmac } from "node:crypto";

import { HungerstationProvider } from "./hungerstation.provider";

describe("HungerstationProvider", () => {
  const provider = new HungerstationProvider();
  const secret = "test-hs-secret";

  function sign(body: string): string {
    return createHmac("sha256", secret).update(body, "utf8").digest("hex");
  }

  describe("verifySignature", () => {
    it("accepts a correctly signed body", () => {
      const body = JSON.stringify({ order_id: "1", items: [] });
      expect(
        provider.verifySignature(body, { "x-hungerstation-signature": sign(body) }, secret),
      ).toBe(true);
    });

    it("accepts the sha256= prefixed form", () => {
      const body = JSON.stringify({ order_id: "1", items: [] });
      expect(
        provider.verifySignature(
          body,
          { "x-hungerstation-signature": `sha256=${sign(body)}` },
          secret,
        ),
      ).toBe(true);
    });

    it("rejects a tampered body", () => {
      const body = JSON.stringify({ order_id: "1", items: [] });
      const signature = sign(body);
      const tampered = JSON.stringify({ order_id: "2", items: [] });
      expect(provider.verifySignature(tampered, { "x-hungerstation-signature": signature }, secret)).toBe(
        false,
      );
    });

    it("rejects a missing signature header", () => {
      const body = JSON.stringify({ order_id: "1", items: [] });
      expect(provider.verifySignature(body, {}, secret)).toBe(false);
    });
  });

  describe("parseOrder", () => {
    it("parses a well-formed order", () => {
      const order = provider.parseOrder({
        order_id: "hs-1",
        store_id: "store-1",
        customer_name: "Ali",
        customer_phone: "+966500000000",
        commission: "12.00",
        items: [{ item_id: "ext-1", name: "Juice", quantity: 2 }],
      });
      expect(order).toEqual({
        externalOrderId: "hs-1",
        externalStoreId: "store-1",
        customerName: "Ali",
        customerPhone: "+966500000000",
        commission: "12.00",
        lines: [{ externalItemId: "ext-1", externalItemName: "Juice", quantity: 2 }],
      });
    });

    it("rejects a missing order_id", () => {
      expect(() => provider.parseOrder({ items: [{ item_id: "x", quantity: 1 }] })).toThrow();
    });

    it("rejects an empty items array", () => {
      expect(() => provider.parseOrder({ order_id: "hs-2", items: [] })).toThrow();
    });

    it("rejects a non-integer quantity", () => {
      expect(() =>
        provider.parseOrder({ order_id: "hs-3", items: [{ item_id: "x", quantity: 1.5 }] }),
      ).toThrow();
    });

    it("rejects a non-object body", () => {
      expect(() => provider.parseOrder("not an object")).toThrow();
    });
  });
});
