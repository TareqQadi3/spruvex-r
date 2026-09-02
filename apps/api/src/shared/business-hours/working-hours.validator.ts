import { BadRequestException } from "@nestjs/common";

import { ORDERING_CHANNELS, WEEKDAY_KEYS, type BranchWorkingHours, type OrderingChannel, type WeekSchedule } from "@spruvex-r/types";

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGES_PER_DAY = 6;
const MAX_EXCEPTIONS = 366;

function fail(message: string): never {
  throw new BadRequestException(message);
}

function parseRanges(value: unknown, context: string) {
  if (!Array.isArray(value)) fail(`${context} must be an array of {from, to} ranges`);
  if (value.length > MAX_RANGES_PER_DAY) fail(`${context} allows at most ${MAX_RANGES_PER_DAY} ranges`);
  return value.map((r, i) => {
    if (typeof r !== "object" || r === null) fail(`${context}[${i}] must be an object`);
    const { from, to } = r as Record<string, unknown>;
    if (typeof from !== "string" || !TIME_RE.test(from)) fail(`${context}[${i}].from must be "HH:mm"`);
    if (typeof to !== "string" || !TIME_RE.test(to)) fail(`${context}[${i}].to must be "HH:mm"`);
    return { from, to };
  });
}

function parseWeekSchedule(value: unknown, context: string): WeekSchedule {
  if (typeof value !== "object" || value === null) fail(`${context} must be an object keyed by weekday`);
  const result: WeekSchedule = {};
  for (const [key, ranges] of Object.entries(value as Record<string, unknown>)) {
    if (!WEEKDAY_KEYS.includes(key as (typeof WEEKDAY_KEYS)[number])) {
      fail(`${context} has an invalid weekday key "${key}" — use sun/mon/tue/wed/thu/fri/sat`);
    }
    result[key as (typeof WEEKDAY_KEYS)[number]] = parseRanges(ranges, `${context}.${key}`);
  }
  return result;
}

/** Validates the full nested working-hours shape at runtime, throwing 400 on any malformed piece. */
export function parseWorkingHours(input: unknown): BranchWorkingHours {
  if (typeof input !== "object" || input === null) fail("workingHours must be an object");
  const raw = input as Record<string, unknown>;
  const result: BranchWorkingHours = {};

  if (raw.schedule !== undefined) {
    result.schedule = parseWeekSchedule(raw.schedule, "schedule");
  }

  if (raw.channelSchedule !== undefined) {
    if (typeof raw.channelSchedule !== "object" || raw.channelSchedule === null) {
      fail("channelSchedule must be an object keyed by channel");
    }
    const channelSchedule: Partial<Record<OrderingChannel, WeekSchedule>> = {};
    for (const [channel, week] of Object.entries(raw.channelSchedule as Record<string, unknown>)) {
      if (!ORDERING_CHANNELS.includes(channel as OrderingChannel)) {
        fail(`channelSchedule has an invalid channel "${channel}"`);
      }
      channelSchedule[channel as OrderingChannel] = parseWeekSchedule(week, `channelSchedule.${channel}`);
    }
    result.channelSchedule = channelSchedule;
  }

  if (raw.exceptions !== undefined) {
    if (!Array.isArray(raw.exceptions)) fail("exceptions must be an array");
    if (raw.exceptions.length > MAX_EXCEPTIONS) fail(`exceptions allows at most ${MAX_EXCEPTIONS} entries`);
    result.exceptions = raw.exceptions.map((e, i) => {
      if (typeof e !== "object" || e === null) fail(`exceptions[${i}] must be an object`);
      const ex = e as Record<string, unknown>;
      if (typeof ex.date !== "string" || !DATE_RE.test(ex.date)) {
        fail(`exceptions[${i}].date must be "YYYY-MM-DD"`);
      }
      if (ex.channel !== undefined && !ORDERING_CHANNELS.includes(ex.channel as OrderingChannel)) {
        fail(`exceptions[${i}].channel is invalid`);
      }
      if (ex.closed !== undefined && typeof ex.closed !== "boolean") {
        fail(`exceptions[${i}].closed must be a boolean`);
      }
      if (ex.label !== undefined && (typeof ex.label !== "string" || ex.label.length > 100)) {
        fail(`exceptions[${i}].label must be a string up to 100 chars`);
      }
      return {
        date: ex.date,
        channel: ex.channel as OrderingChannel | undefined,
        closed: ex.closed as boolean | undefined,
        hours: ex.hours !== undefined ? parseRanges(ex.hours, `exceptions[${i}].hours`) : undefined,
        label: ex.label as string | undefined,
      };
    });
  }

  return result;
}
