import { describe, expect, it } from "vitest";

import {
  JobScheduleError,
  latestOccurrence,
  nextOccurrence,
  parseJobSchedule,
  type JobSchedule,
} from "./jobSchedule.js";

const at = (iso: string) => Date.parse(iso);
const iso = (instant: number) => new Date(instant).toISOString();
const MINUTE = 60_000;

describe("job schedules", () => {
  it("runs daily at a local time in the schedule's time zone", () => {
    const schedule: JobSchedule = {
      kind: "daily",
      time: "07:30",
      timeZone: "Australia/Sydney",
    };
    // 11:00 on Saturday 10 October in Sydney (UTC+11): next is Sunday 07:30.
    expect(iso(nextOccurrence(schedule, at("2026-10-10T00:00:00Z"), 0))).toBe(
      "2026-10-10T20:30:00.000Z",
    );
    // Exactly at an occurrence: the next one is a day later.
    expect(iso(nextOccurrence(schedule, at("2026-10-10T20:30:00Z"), 0))).toBe(
      "2026-10-11T20:30:00.000Z",
    );
  });

  it("runs weekly on the chosen days", () => {
    const schedule: JobSchedule = {
      kind: "weekly",
      days: ["mon", "fri"],
      time: "09:00",
      timeZone: "UTC",
    };
    // Saturday 10 October 2026: next is Monday the 12th.
    expect(iso(nextOccurrence(schedule, at("2026-10-10T12:00:00Z"), 0))).toBe(
      "2026-10-12T09:00:00.000Z",
    );
    expect(iso(nextOccurrence(schedule, at("2026-10-12T09:00:00Z"), 0))).toBe(
      "2026-10-16T09:00:00.000Z",
    );
  });

  it("counts intervals from when the schedule was set", () => {
    const anchor = at("2026-10-10T00:00:00Z");
    const schedule: JobSchedule = { kind: "interval", everyMinutes: 15 };
    expect(nextOccurrence(schedule, anchor, anchor)).toBe(anchor + 15 * MINUTE);
    expect(nextOccurrence(schedule, anchor + 31 * MINUTE, anchor)).toBe(
      anchor + 45 * MINUTE,
    );
    expect(latestOccurrence(schedule, anchor + 31 * MINUTE, anchor)).toBe(
      anchor + 30 * MINUTE,
    );
    expect(latestOccurrence(schedule, anchor + 5 * MINUTE, anchor)).toBe(
      undefined,
    );
  });

  it("runs a local time the clocks jump over at the next valid minute", () => {
    // Sydney moves from 02:00 to 03:00 on Sunday 4 October 2026.
    const schedule: JobSchedule = {
      kind: "daily",
      time: "02:30",
      timeZone: "Australia/Sydney",
    };
    const gapDay = nextOccurrence(schedule, at("2026-10-03T12:00:00Z"), 0);
    expect(iso(gapDay)).toBe("2026-10-03T16:00:00.000Z"); // 03:00 AEDT
    expect(iso(nextOccurrence(schedule, gapDay, 0))).toBe(
      "2026-10-04T15:30:00.000Z", // 02:30 AEDT on the 5th
    );
  });

  it("runs a local time that happens twice only once", () => {
    // Sydney moves from 03:00 back to 02:00 on Sunday 5 April 2026.
    const schedule: JobSchedule = {
      kind: "daily",
      time: "02:30",
      timeZone: "Australia/Sydney",
    };
    const first = nextOccurrence(schedule, at("2026-04-04T12:00:00Z"), 0);
    expect(iso(first)).toBe("2026-04-04T15:30:00.000Z"); // 02:30 AEDT
    // Not again at 02:30 AEST an hour later: the next run is the 6th.
    expect(iso(nextOccurrence(schedule, first, 0))).toBe(
      "2026-04-05T16:30:00.000Z",
    );
  });

  it("keeps local times across a daylight saving change", () => {
    const schedule: JobSchedule = {
      kind: "daily",
      time: "09:00",
      timeZone: "America/New_York",
    };
    const saturday = nextOccurrence(schedule, at("2026-10-31T00:00:00Z"), 0);
    expect(iso(saturday)).toBe("2026-10-31T13:00:00.000Z"); // EDT
    expect(iso(nextOccurrence(schedule, saturday, 0))).toBe(
      "2026-11-01T14:00:00.000Z", // EST
    );
  });

  it("finds the latest missed occurrence after the anchor", () => {
    const schedule: JobSchedule = {
      kind: "daily",
      time: "07:30",
      timeZone: "Australia/Sydney",
    };
    const now = at("2026-10-11T21:00:00Z"); // 08:00 on the 12th in Sydney
    expect(iso(latestOccurrence(schedule, now, 0)!)).toBe(
      "2026-10-11T20:30:00.000Z",
    );
    expect(
      latestOccurrence(schedule, now, at("2026-10-11T20:45:00Z")),
    ).toBeUndefined();
  });

  it("validates schedule input", () => {
    const fails = (value: unknown, code: string) => {
      expect(() => parseJobSchedule(value, "UTC")).toThrow(
        new JobScheduleError(code),
      );
    };
    fails({ kind: "interval", everyMinutes: 10 }, "schedule_interval_invalid");
    fails(
      { kind: "interval", everyMinutes: 15.5 },
      "schedule_interval_invalid",
    );
    fails({ kind: "daily", time: "24:00" }, "schedule_time_invalid");
    fails({ kind: "daily", time: "7:30" }, "schedule_time_invalid");
    fails(
      { kind: "daily", time: "07:30", timeZone: "Mars/Olympus" },
      "schedule_time_zone_invalid",
    );
    fails({ kind: "weekly", days: [], time: "07:30" }, "schedule_days_invalid");
    fails(
      { kind: "weekly", days: ["monday"], time: "07:30" },
      "schedule_days_invalid",
    );
    fails({ kind: "daily", time: "07:30", cron: "* * *" }, "schedule_invalid");
    fails({ kind: "cron" }, "schedule_invalid");
    fails("daily", "schedule_invalid");

    expect(
      parseJobSchedule(
        { kind: "weekly", days: ["fri", "mon", "fri"], time: "07:30" },
        "Australia/Sydney",
      ),
    ).toEqual({
      kind: "weekly",
      days: ["mon", "fri"],
      time: "07:30",
      timeZone: "Australia/Sydney",
    });
    expect(
      parseJobSchedule({ kind: "interval", everyMinutes: 60 }, "UTC"),
    ).toEqual({ kind: "interval", everyMinutes: 60 });
  });
});
