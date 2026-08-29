import { MoyasarProvider } from "./moyasar.provider";

describe("MoyasarProvider", () => {
  const provider = new MoyasarProvider();
  const secret = "test-secret-token";

  describe("verifyWebhook", () => {
    it("accepts a body carrying the correct secret_token", () => {
      const body = JSON.stringify({ secret_token: secret, data: { status: "paid" } });
      expect(provider.verifyWebhook(body, {}, secret)).toBe(true);
    });

    it("rejects a wrong secret_token", () => {
      const body = JSON.stringify({ secret_token: "wrong", data: {} });
      expect(provider.verifyWebhook(body, {}, secret)).toBe(false);
    });

    it("rejects a missing secret_token", () => {
      const body = JSON.stringify({ data: {} });
      expect(provider.verifyWebhook(body, {}, secret)).toBe(false);
    });

    it("rejects malformed JSON", () => {
      expect(provider.verifyWebhook("{not json", {}, secret)).toBe(false);
    });
  });

  describe("parseWebhookEvent", () => {
    it("parses a paid event", () => {
      const event = provider.parseWebhookEvent({
        data: { id: "pay_123", status: "paid", amount: 8550, metadata: { order_id: "order-1" } },
      });
      expect(event).toEqual({ orderId: "order-1", success: true, gatewayReference: "pay_123", amount: "85.50" });
    });

    it("marks a non-paid status as unsuccessful", () => {
      const event = provider.parseWebhookEvent({
        data: { id: "pay_124", status: "failed", metadata: { order_id: "order-2" } },
      });
      expect(event.success).toBe(false);
    });

    it("rejects a body with no order_id in metadata", () => {
      expect(() =>
        provider.parseWebhookEvent({ data: { id: "pay_125", status: "paid", metadata: {} } }),
      ).toThrow();
    });
  });
});
