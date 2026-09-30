import {
  MeridianQuotaParseError,
  parseMeridianQuotaResponse,
  windowLabel,
} from "./meridianQuota.js";
import { describe, expect, it } from "vitest";

const NOW = 1_800_000_000_000;

describe("parseMeridianQuotaResponse", () => {
  it("keeps accounts separate and converts units exactly once", () => {
    const accounts = parseMeridianQuotaResponse(
      {
        activeProfile: "work",
        profiles: [
          {
            id: "work",
            isActive: true,
            windows: [
              { type: "five_hour", utilization: 0.42, resetsAt: NOW + 60_000 },
              { type: "seven_day", utilization: null, resetsAt: NOW + 5_000 },
              { type: "seven_day_opus_4", utilization: 1.2, resetsAt: null },
            ],
            fetchedAt: NOW - 10_000,
            stale: false,
            error: null,
          },
          {
            id: "personal",
            isActive: false,
            windows: [{ type: "five_hour", utilization: 0.1, resetsAt: null }],
            fetchedAt: NOW - 1_000,
          },
        ],
      },
      { nowMs: NOW },
    );

    expect(accounts.map((account) => account.id)).toEqual(["work", "personal"]);
    expect(accounts[0]).toMatchObject({
      isActive: true,
      available: true,
      stale: false,
      observedAtMs: NOW - 10_000,
    });
    expect(accounts[0]!.windows).toEqual([
      {
        id: "five_hour",
        label: "5-hour",
        usedPercent: 42,
        resetsAt: (NOW + 60_000) / 1_000,
      },
      {
        id: "seven_day",
        label: "Weekly",
        usedPercent: null,
        resetsAt: (NOW + 5_000) / 1_000,
      },
      {
        id: "seven_day_opus_4",
        label: "Weekly Opus 4",
        usedPercent: 120,
        resetsAt: null,
      },
    ]);
  });

  it("hides a percentage whose window reset after the reading", () => {
    const [account] = parseMeridianQuotaResponse(
      {
        profiles: [
          {
            id: "a",
            windows: [{ type: "five_hour", utilization: 0.9, resetsAt: NOW }],
            fetchedAt: NOW - 1_000,
          },
        ],
      },
      { nowMs: NOW },
    );
    expect(account!.windows[0]).toMatchObject({
      usedPercent: null,
      resetSinceObservation: true,
    });
  });

  it("maps profile errors, stale readings and refusal status", () => {
    const accounts = parseMeridianQuotaResponse(
      {
        profiles: [
          { id: "api", windows: [], error: "not_oauth" },
          { id: "missing", windows: [], error: "no_token" },
          {
            id: "old",
            stale: true,
            windows: [{ type: "five_hour", utilization: 0.5 }],
            fetchedAt: NOW - 6 * 60_000,
          },
          {
            id: "unknown-age",
            stale: true,
            windows: [{ type: "five_hour", utilization: 0.5 }],
          },
          {
            id: "spent",
            windows: [{ type: "five_hour", utilization: 1 }],
            fetchedAt: NOW,
            spent: { until: NOW + 60_000 },
          },
        ],
      },
      { nowMs: NOW },
    );
    expect(accounts[0]).toMatchObject({ available: false });
    expect(accounts[0]!.reason).toMatch(/subscription login/);
    expect(accounts[1]!.reason).toMatch(/claude login/);
    expect(accounts[2]).toMatchObject({ available: false, stale: true });
    expect(accounts[3]).toMatchObject({ available: false, stale: true });
    expect(accounts[4]!.statusNote).toMatch(/refusing requests/);
  });

  it("drops malformed and duplicate profiles and bounds labels", () => {
    const accounts = parseMeridianQuotaResponse(
      {
        profiles: [
          null,
          { id: 3 },
          { id: "dup", windows: [] },
          { id: "dup", windows: [] },
        ],
      },
      { nowMs: NOW },
    );
    expect(accounts.map((account) => account.id)).toEqual(["dup"]);
    expect(windowLabel("x".repeat(200)).length).toBeLessThanOrEqual(64);
  });

  it("rejects responses without a profiles array", () => {
    expect(() =>
      parseMeridianQuotaResponse({ buckets: [] }, { nowMs: NOW }),
    ).toThrow(MeridianQuotaParseError);
  });
});
