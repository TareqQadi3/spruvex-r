import { buildZatcaPhase2QrPayload, buildZatcaQrPayload, decodeZatcaQrPayload } from "./tlv";

describe("ZATCA Phase 1 TLV QR payload", () => {
  const input = {
    sellerName: "مطعم البيك الشعبي",
    vatNumber: "300000000000003",
    timestamp: "2026-07-12T14:30:00.000Z",
    total: "115.00",
    vatAmount: "15.00",
  };

  it("round-trips all five mandatory tags (UTF-8 Arabic safe)", () => {
    const payload = buildZatcaQrPayload(input);
    // Valid Base64
    expect(Buffer.from(payload, "base64").toString("base64")).toBe(payload);

    const tags = decodeZatcaQrPayload(payload);
    expect(tags.get(1)).toBe(input.sellerName);
    expect(tags.get(2)).toBe(input.vatNumber);
    expect(tags.get(3)).toBe(input.timestamp);
    expect(tags.get(4)).toBe(input.total);
    expect(tags.get(5)).toBe(input.vatAmount);
  });

  it("encodes lengths in BYTES, not characters (Arabic is multi-byte)", () => {
    const payload = buildZatcaQrPayload(input);
    const bytes = Buffer.from(payload, "base64");
    // First record: tag=1, length = utf8 byte length of the Arabic name.
    expect(bytes[0]).toBe(1);
    expect(bytes[1]).toBe(Buffer.byteLength(input.sellerName, "utf8"));
  });

  it("rejects oversized values", () => {
    expect(() =>
      buildZatcaQrPayload({ ...input, sellerName: "x".repeat(300) }),
    ).toThrow(/255/);
  });
});

describe("ZATCA Phase 2 TLV QR payload", () => {
  const input = {
    sellerName: "مطعم البيك الشعبي",
    vatNumber: "300000000000003",
    timestamp: "2026-07-12T14:30:00.000Z",
    total: "115.00",
    vatAmount: "15.00",
    invoiceHash: Buffer.from("1".repeat(64), "hex"),
    signature: Buffer.from([0x30, 0x44, 0x02, 0x20, ...Array(32).fill(0xaa), 0x02, 0x20, ...Array(32).fill(0xbb)]),
    publicKey: Buffer.from([0x04, ...Array(64).fill(0xcc)]),
  };

  it("is a strict superset of the Phase 1 tags (1-5 identical)", () => {
    const phase1 = buildZatcaQrPayload(input);
    const phase2 = buildZatcaPhase2QrPayload(input);

    const tags1 = decodeZatcaQrPayload(phase1);
    const tags2 = decodeZatcaQrPayload(phase2);
    for (const tag of [1, 2, 3, 4, 5]) {
      expect(tags2.get(tag)).toBe(tags1.get(tag));
    }
  });

  it("includes tags 6-8 as raw binary, decodable back to the same bytes", () => {
    const payload = buildZatcaPhase2QrPayload(input);
    const bytes = Buffer.from(payload, "base64");

    // Walk the TLV records ourselves (decodeZatcaQrPayload assumes UTF-8
    // text values, which tags 6-8 are not).
    let offset = 0;
    const raw = new Map<number, Buffer>();
    while (offset + 2 <= bytes.length) {
      const tag = bytes[offset];
      const length = bytes[offset + 1];
      raw.set(tag, bytes.subarray(offset + 2, offset + 2 + length));
      offset += 2 + length;
    }
    expect(raw.get(6)?.equals(input.invoiceHash)).toBe(true);
    expect(raw.get(7)?.equals(input.signature)).toBe(true);
    expect(raw.get(8)?.equals(input.publicKey)).toBe(true);
    expect(raw.has(9)).toBe(false);
  });

  it("includes tag 9 only once ZATCA's stamp signature is supplied", () => {
    function tagsPresent(payload: string): Set<number> {
      const bytes = Buffer.from(payload, "base64");
      const tags = new Set<number>();
      let offset = 0;
      while (offset + 2 <= bytes.length) {
        tags.add(bytes[offset]);
        offset += 2 + bytes[offset + 1];
      }
      return tags;
    }

    expect(tagsPresent(buildZatcaPhase2QrPayload(input)).has(9)).toBe(false);
    expect(
      tagsPresent(
        buildZatcaPhase2QrPayload({ ...input, stampSignature: Buffer.from([1, 2, 3]) }),
      ).has(9),
    ).toBe(true);
  });
});
