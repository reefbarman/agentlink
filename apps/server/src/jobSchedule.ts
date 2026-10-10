/**
 * When scheduled jobs run: every N minutes, daily at a local time, or on
 * chosen weekdays at a local time, each in an IANA time zone. Time zone
 * maths uses `Intl.DateTimeFormat` only.
 *
 * Daylight saving: a local time that does not exist (the clocks jump over
 * it) runs at the next minute that does; a local time that happens twice
 * (the clocks go back) runs once, at its first occurrence.
 */

export const MIN_INTERVAL_MINUTES = 15;
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
export const WEEKDAYS = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export type JobSchedule =
  | { readonly kind: "interval"; readonly everyMinutes: number }
  | {
      readonly kind: "daily";
      /** Local `HH:MM`, 24-hour. */
      readonly time: string;
      readonly timeZone: string;
    }
  | {
      readonly kind: "weekly";
      /** Distinct days in week order, Sunday first. */
      readonly days: readonly Weekday[];
      readonly time: string;
      readonly timeZone: string;
    };

export class JobScheduleError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "JobScheduleError";
  }
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/u;
const MAX_TIME_ZONE_LENGTH = 64;
/** Longest daylight saving jump searched past (real ones are at most 2 h). */
const MAX_GAP_MINUTES = 180;

/** The server's own time zone, used when a schedule names none. */
export function serverTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Validate untrusted schedule input; throws `JobScheduleError`. */
export function parseJobSchedule(
  value: unknown,
  defaultTimeZone: string,
): JobSchedule {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new JobScheduleError("schedule_invalid");
  }
  const input = value as Record<string, unknown>;
  const allowOnly = (...keys: string[]) => {
    if (
      Object.keys(input).some((key) => key !== "kind" && !keys.includes(key))
    ) {
      throw new JobScheduleError("schedule_invalid");
    }
  };
  switch (input.kind) {
    case "interval": {
      allowOnly("everyMinutes");
      const every = input.everyMinutes;
      if (
        typeof every !== "number" ||
        !Number.isInteger(every) ||
        every < MIN_INTERVAL_MINUTES ||
        every > MAX_INTERVAL_MINUTES
      ) {
        throw new JobScheduleError("schedule_interval_invalid");
      }
      return { kind: "interval", everyMinutes: every };
    }
    case "daily": {
      allowOnly("time", "timeZone");
      return {
        kind: "daily",
        time: parseTime(input.time),
        timeZone: parseTimeZone(input.timeZone ?? defaultTimeZone),
      };
    }
    case "weekly": {
      allowOnly("days", "time", "timeZone");
      const days = input.days;
      if (
        !Array.isArray(days) ||
        days.length === 0 ||
        !days.every((day): day is Weekday =>
          (WEEKDAYS as readonly unknown[]).includes(day),
        )
      ) {
        throw new JobScheduleError("schedule_days_invalid");
      }
      return {
        kind: "weekly",
        days: WEEKDAYS.filter((day) => days.includes(day)),
        time: parseTime(input.time),
        timeZone: parseTimeZone(input.timeZone ?? defaultTimeZone),
      };
    }
    default:
      throw new JobScheduleError("schedule_invalid");
  }
}

/**
 * The first occurrence strictly after `after`. Intervals count from
 * `anchor` (when the schedule was set), so the first run is one interval
 * after it.
 */
export function nextOccurrence(
  schedule: JobSchedule,
  after: number,
  anchor: number,
): number {
  if (schedule.kind === "interval") {
    const period = schedule.everyMinutes * MINUTE_MS;
    const count = Math.max(1, Math.floor((after - anchor) / period) + 1);
    return anchor + count * period;
  }
  const { hour, minute } = splitTime(schedule.time);
  const today = wallClock(after, schedule.timeZone);
  for (let offset = 0; offset <= 8; offset += 1) {
    const at = occurrenceOn(schedule, today, offset, hour, minute);
    if (at !== undefined && at > after) return at;
  }
  // Unreachable for valid schedules: every week has a matching day.
  throw new JobScheduleError("schedule_invalid");
}

/**
 * The last occurrence at or before `atOrBefore`, or undefined when there is
 * none since `anchor`. Used to coalesce runs missed while the server was
 * down into one.
 */
export function latestOccurrence(
  schedule: JobSchedule,
  atOrBefore: number,
  anchor: number,
): number | undefined {
  if (schedule.kind === "interval") {
    const period = schedule.everyMinutes * MINUTE_MS;
    const count = Math.floor((atOrBefore - anchor) / period);
    return count >= 1 ? anchor + count * period : undefined;
  }
  const { hour, minute } = splitTime(schedule.time);
  const today = wallClock(atOrBefore, schedule.timeZone);
  for (let offset = 0; offset >= -8; offset -= 1) {
    const at = occurrenceOn(schedule, today, offset, hour, minute);
    if (at !== undefined && at <= atOrBefore) {
      return at > anchor ? at : undefined;
    }
  }
  return undefined;
}

interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/** The schedule's instant on the local day `offset` days from `base`. */
function occurrenceOn(
  schedule: Extract<JobSchedule, { kind: "daily" | "weekly" }>,
  base: WallClock,
  offset: number,
  hour: number,
  minute: number,
): number | undefined {
  const date = new Date(Date.UTC(base.year, base.month - 1, base.day + offset));
  if (
    schedule.kind === "weekly" &&
    !schedule.days.includes(WEEKDAYS[date.getUTCDay()]!)
  ) {
    return undefined;
  }
  return localInstant(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    hour,
    minute,
    schedule.timeZone,
  );
}

/**
 * The instant a local time happens in `timeZone`: the first of two when
 * the clocks go back, the next valid minute when they jump over it.
 */
export function localInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  for (let skipped = 0; skipped <= MAX_GAP_MINUTES; skipped += 1) {
    const wanted = Date.UTC(year, month - 1, day, hour, minute + skipped);
    // Offsets around the wanted time cover both sides of any transition.
    const candidates = [wanted - DAY_MS, wanted, wanted + DAY_MS]
      .map((probe) => wanted - offsetAt(probe, timeZone))
      .filter((instant) => sameMinute(wallClock(instant, timeZone), wanted))
      .sort((left, right) => left - right);
    if (candidates[0] !== undefined) return candidates[0];
  }
  throw new JobScheduleError("schedule_time_unresolvable");
}

function sameMinute(clock: WallClock, wanted: number): boolean {
  return (
    Date.UTC(
      clock.year,
      clock.month - 1,
      clock.day,
      clock.hour,
      clock.minute,
    ) === wanted
  );
}

/** Local time minus UTC at `instant`, in milliseconds. */
function offsetAt(instant: number, timeZone: string): number {
  const clock = wallClock(instant, timeZone);
  const local = Date.UTC(
    clock.year,
    clock.month - 1,
    clock.day,
    clock.hour,
    clock.minute,
    clock.second,
  );
  return local - Math.floor(instant / 1_000) * 1_000;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function wallClock(instant: number, timeZone: string): WallClock {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, format);
  }
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(instant)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
    second: parts.second!,
  };
}

function parseTime(value: unknown): string {
  if (typeof value !== "string" || !TIME_PATTERN.test(value)) {
    throw new JobScheduleError("schedule_time_invalid");
  }
  return value;
}

function splitTime(time: string): { hour: number; minute: number } {
  const [hour, minute] = time.split(":").map(Number);
  return { hour: hour!, minute: minute! };
}

function parseTimeZone(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > MAX_TIME_ZONE_LENGTH
  ) {
    throw new JobScheduleError("schedule_time_zone_invalid");
  }
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: value,
    }).resolvedOptions().timeZone;
  } catch {
    throw new JobScheduleError("schedule_time_zone_invalid");
  }
}
