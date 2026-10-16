import { sarToHalalas } from "../../shared/common/money";

/** Resolves a date range from optional from/to query params — shared by every report. */
export function resolveRange(from?: string, to?: string): { start: Date; end: Date } {
  // `to` is a calendar date (e.g. "2026-07-13"); treat it as inclusive through
  // the end of that day rather than its literal midnight instant, otherwise
  // every order placed "today" is silently excluded from an end=today range.
  const end = to
    ? (() => {
        const d = new Date(to);
        return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - 1);
      })()
    : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { start, end };
}

/** Sums a nullable Decimal-ish field across rows as halalas (2-decimal SAR fields). */
export function sumHalalas(values: Array<{ toString(): string } | null>): number {
  return values.reduce((sum: number, v) => sum + (v ? sarToHalalas(v.toString()) : 0), 0);
}
