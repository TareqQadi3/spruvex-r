import type { OrderingChannel } from "./domain";

/**
 * Business-hours resolution — pure, framework-agnostic, and the single
 * source of truth used by both the API (order-creation guard) and any
 * frontend that wants to render "closed until X" without duplicating the
 * logic. All calendar-date/time-of-day math assumes Asia/Riyadh, a fixed
 * UTC+3 offset with no daylight saving — correct for every market this
 * platform (Saudi ZATCA-focused) serves, so no timezone library is needed.
 */

export type WeekdayKey = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";

export const WEEKDAY_KEYS: readonly WeekdayKey[] = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
];

/** 24h "HH:mm" strings. `to <= from` means the range crosses midnight (e.g. 18:00-02:00). */
export interface TimeRange {
  from: string;
  to: string;
}

export type WeekSchedule = Partial<Record<WeekdayKey, TimeRange[]>>;

export interface ScheduleException {
  /** "YYYY-MM-DD", Asia/Riyadh calendar date. */
  date: string;
  /** Omitted = applies to every channel; a channel-specific row for the same date wins. */
  channel?: OrderingChannel;
  /** Full closure that date — takes priority over `hours` when both are set. */
  closed?: boolean;
  /** Special hours that date (only meaningful when `closed` is not true). Does not carry over midnight into the next date. */
  hours?: TimeRange[];
  /** Shown to staff/customers, e.g. "رمضان", "اليوم الوطني". */
  label?: string;
}

export interface BranchWorkingHours {
  /** Baseline weekly schedule, applies to every channel unless overridden below. */
  schedule?: WeekSchedule;
  /** Optional per-channel override of the weekly schedule (e.g. delivery closes earlier). */
  channelSchedule?: Partial<Record<OrderingChannel, WeekSchedule>>;
  exceptions?: ScheduleException[];
}

export type ChannelOpenReason =
  | "always_open_unconfigured"
  | "exception_closed"
  | "exception_open"
  | "weekly_open"
  | "weekly_closed"
  /** Set only by BusinessHoursService when a manual/system pause is active — never returned by resolveChannelOpenState itself. */
  | "paused";

export interface ChannelOpenState {
  open: boolean;
  reason: ChannelOpenReason;
  /** The exception's label, when an exception row drove this result. */
  label?: string;
}

const RIYADH_OFFSET_MINUTES = 180;

function toRiyadhParts(utcMs: number): { dateStr: string; minutesOfDay: number; weekday: WeekdayKey } {
  const shifted = new Date(utcMs + RIYADH_OFFSET_MINUTES * 60_000);
  return {
    dateStr: shifted.toISOString().slice(0, 10),
    minutesOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    weekday: WEEKDAY_KEYS[shifted.getUTCDay()],
  };
}

function parseHHMM(value: string): number {
  const [h, m] = value.split(":").map((part) => Number(part));
  return h * 60 + m;
}

/** Is `minutesOfDay` inside `range`, treating it as belonging to the range's own calendar day. */
function withinRangeToday(minutesOfDay: number, range: TimeRange): boolean {
  const from = parseHHMM(range.from);
  const to = parseHHMM(range.to);
  if (to > from) return minutesOfDay >= from && minutesOfDay < to;
  // Overnight range (e.g. 18:00-02:00): today's portion runs from `from` until midnight.
  return minutesOfDay >= from;
}

/** Is `minutesOfDay` still inside `range`'s overnight carry-over from the PREVIOUS calendar day. */
function withinRangeFromYesterday(minutesOfDay: number, range: TimeRange): boolean {
  const from = parseHHMM(range.from);
  const to = parseHHMM(range.to);
  if (to > from) return false; // not an overnight range
  return minutesOfDay < to;
}

function hasAnyScheduleConfigured(hours: BranchWorkingHours | null | undefined): boolean {
  if (!hours) return false;
  if (hours.schedule && Object.keys(hours.schedule).length > 0) return true;
  return Object.values(hours.channelSchedule ?? {}).some(
    (week) => week && Object.keys(week).length > 0,
  );
}

/**
 * Resolves whether `channel` is open right now at a branch. A branch that has
 * never configured ANY schedule (the default for every existing tenant) is
 * always open — hours-based gating only activates once a merchant adds at
 * least one weekly slot, so this is a purely additive, backward-compatible
 * feature.
 */
export function resolveChannelOpenState(
  hours: BranchWorkingHours | null | undefined,
  channel: OrderingChannel,
  nowUtcMs: number,
): ChannelOpenState {
  if (!hasAnyScheduleConfigured(hours)) {
    return { open: true, reason: "always_open_unconfigured" };
  }

  const { dateStr, minutesOfDay, weekday } = toRiyadhParts(nowUtcMs);
  const prevWeekday = WEEKDAY_KEYS[(WEEKDAY_KEYS.indexOf(weekday) + 6) % 7];

  const exceptions = hours?.exceptions ?? [];
  const specific = exceptions.find((e) => e.date === dateStr && e.channel === channel);
  const general = exceptions.find((e) => e.date === dateStr && !e.channel);
  const exception = specific ?? general;
  if (exception) {
    if (exception.closed) {
      return { open: false, reason: "exception_closed", label: exception.label };
    }
    if (exception.hours) {
      const open = exception.hours.some((r) => withinRangeToday(minutesOfDay, r));
      return { open, reason: "exception_open", label: exception.label };
    }
  }

  const effectiveWeekly = hours?.channelSchedule?.[channel] ?? hours?.schedule ?? {};
  const todayRanges = effectiveWeekly[weekday] ?? [];
  const yesterdayRanges = effectiveWeekly[prevWeekday] ?? [];
  const open =
    todayRanges.some((r) => withinRangeToday(minutesOfDay, r)) ||
    yesterdayRanges.some((r) => withinRangeFromYesterday(minutesOfDay, r));

  return { open, reason: open ? "weekly_open" : "weekly_closed" };
}

/** Today's effective ranges for `channel` (after applying any channel/exception override) — for a simple "opens today at X" UI hint. Returns null when today is a full closure. */
export function todaysEffectiveRanges(
  hours: BranchWorkingHours | null | undefined,
  channel: OrderingChannel,
  nowUtcMs: number,
): TimeRange[] | null {
  if (!hasAnyScheduleConfigured(hours)) return null;
  const { dateStr, weekday } = toRiyadhParts(nowUtcMs);
  const exceptions = hours?.exceptions ?? [];
  const exception =
    exceptions.find((e) => e.date === dateStr && e.channel === channel) ??
    exceptions.find((e) => e.date === dateStr && !e.channel);
  if (exception) {
    return exception.closed ? null : (exception.hours ?? null);
  }
  const effectiveWeekly = hours?.channelSchedule?.[channel] ?? hours?.schedule ?? {};
  return effectiveWeekly[weekday] ?? null;
}
