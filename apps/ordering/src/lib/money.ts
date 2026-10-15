/** Display-only money helpers — the server recomputes totals authoritatively. */

export function toHalalas(decimal: string): number {
  const sign = decimal.startsWith("-") ? -1 : 1;
  const [whole, fraction = ""] = decimal.replace("-", "").split(".");
  return sign * (Number(whole) * 100 + Number(fraction.padEnd(2, "0").slice(0, 2) || "0"));
}

export function formatMoney(decimal: string, currency = "SAR"): string {
  const halalas = toHalalas(decimal);
  const sign = halalas < 0 ? "-" : "";
  const abs = Math.abs(halalas);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")} ${currency}`;
}

export function addMoney(a: string, b: string): string {
  const halalas = toHalalas(a) + toHalalas(b);
  const sign = halalas < 0 ? "-" : "";
  const abs = Math.abs(halalas);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function multiplyMoney(a: string, factor: number): string {
  const halalas = toHalalas(a) * factor;
  const sign = halalas < 0 ? "-" : "";
  const abs = Math.abs(halalas);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Floored at zero — display-only (the server never lets a discount exceed the subtotal either). */
export function subtractMoney(a: string, b: string): string {
  const halalas = Math.max(0, toHalalas(a) - toHalalas(b));
  return `${Math.floor(halalas / 100)}.${String(halalas % 100).padStart(2, "0")}`;
}
