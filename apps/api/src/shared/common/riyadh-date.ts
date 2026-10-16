const RIYADH_OFFSET_MINUTES = 180;

/**
 * Today's calendar date ("YYYY-MM-DD") in Asia/Riyadh — a fixed UTC+3 offset
 * with no daylight saving, so no timezone library is needed. Used wherever
 * a "sold out for today" or "this exception date" needs to match the
 * merchant's own sense of "today", not the server's UTC date.
 */
export function riyadhDateString(at: Date = new Date()): string {
  return new Date(at.getTime() + RIYADH_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);
}
