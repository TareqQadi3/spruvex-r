import { createHmac } from "node:crypto";

import { TapProvider } from "./tap.provider";

describe("TapProvider", () => {
  const provider = new TapProvider();
  const secret = "test-tap-secret";

  function sign(fields: Record<string, string>): string {
    const toHash =
      `x_id${fields.id ?? ""}` +
      `x_amount${fields.amount ?? ""}` +
      `x_currency${fields.currency ?? ""}` +
      `x_gateway_reference${fields.gateway_reference ?? ""}` +
      `x_payment_reference${fields.payment_reference ?? ""}` +
      `x_status${fields.status ?? ""}` +
      `x_created${fields.created ?? ""}`;
    return createHmac("sha256", secret).update(toHash, "utf8").digest("hex");
  }

  const fields = {
    id: "chg_1",
    amount: "85.5",
    currency: "SAR",
    gateway_reference: "gw_1",
    payment_reference: "pay_1",
    status: "CAPTURED",
    created: "1700000000",
  };

  describe("verifyWebhook", () => {
    it("accepts a correctly signed body", () => {
      const body = JSON.stringify(fields);
      expect(provider.verifyWebhook(body, { hashstring: sign(fields) }, secret)).toBe(true);
    });

    it("rejects a tampered field (amount changed after signing)", () => {
      const signature = sign(fields);
      const tampered = JSON.stringify({ ...fields, amount: "999.00" });
      expect(provider.verifyWebhook(tampered, { hashstring: signature }, secret)).toBe(false);
    });

    it("rejects a missing hashstring header", () => {
      const body = JSON.stringify(fields);
      expect(provider.verifyWebhook(body, {}, secret)).toBe(false);
    });
  });

  describe("parseWebhookEvent", () => {
    it("parses a captured charge", () => {
      const event = provider.parseWebhookEvent({ ...fields, metadata: { order_id: "order-1" } });
      expect(event).toEqual({
        orderId: "order-1",
        success: true,
        gatewayReference: "chg_1",
        amount: undefined,
      });
    });

    it("marks a non-CAPTURED status as unsuccessful", () => {
      const event = provider.parseWebhookEvent({
        ...fields,
        status: "DECLINED",
        metadata: { order_id: "order-2" },
      });
      expect(event.success).toBe(false);
    });

    it("rejects a body with no order_id in metadata", () => {
      expect(() => provider.parseWebhookEvent({ ...fields, metadata: {} })).toThrow();
    });
  });
});
