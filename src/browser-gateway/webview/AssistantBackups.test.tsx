// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BackupSettings,
  backupSummary,
  timeAgo,
  type BackupsResponse,
} from "./AssistantBackups";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const HOUR = 60 * 60 * 1_000;
const NOW = 100 * HOUR;

const success = (at: number) => ({
  at,
  snapshotId: "abcdef0123456789",
  files: 10,
  bytes: 100,
  added: 5,
  durationMs: 1_000,
});

function stubFetch(responses: Record<string, unknown[]>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const key = `${init?.method ?? "GET"} ${url}`;
      calls.push(key);
      const queue = responses[key];
      if (!queue || queue.length === 0) {
        return new Response(JSON.stringify({ error: "not_found" }), {
          status: 404,
        });
      }
      const body = queue.length > 1 ? queue.shift() : queue[0];
      return new Response(JSON.stringify(body), {
        status: key.startsWith("POST") ? 202 : 200,
      });
    }),
  );
  return calls;
}

describe("timeAgo", () => {
  it("speaks in minutes, hours and days", () => {
    expect(timeAgo(NOW, NOW)).toBe("just now");
    expect(timeAgo(NOW - 60_000, NOW)).toBe("1 minute ago");
    expect(timeAgo(NOW - 3 * HOUR, NOW)).toBe("3 hours ago");
    expect(timeAgo(NOW - 72 * HOUR, NOW)).toBe("3 days ago");
  });
});

describe("backupSummary", () => {
  const body = (patch: Partial<BackupsResponse>): BackupsResponse => ({
    configured: true,
    overdueAfterMs: 26 * HOUR,
    status: {},
    ...patch,
  });

  it("shows nothing without a backup service", () => {
    expect(backupSummary({ configured: false }, NOW)).toBeUndefined();
  });

  it("reports each state", () => {
    expect(backupSummary(body({ error: "backup_unavailable" }), NOW)).toEqual({
      text: "Backups: the backup service is not reachable",
      tone: "bad",
    });
    expect(backupSummary(body({}), NOW)).toEqual({
      text: "No backup yet",
      tone: "busy",
    });
    expect(
      backupSummary(body({ status: { runningSince: NOW - 120_000 } }), NOW),
    ).toEqual({ text: "Backing up (started 2 minutes ago)", tone: "busy" });
    expect(
      backupSummary(
        body({ status: { lastSuccess: success(NOW - HOUR) } }),
        NOW,
      ),
    ).toEqual({ text: "Backed up 1 hour ago", tone: "ok" });
    expect(
      backupSummary(
        body({ status: { lastSuccess: success(NOW - 30 * HOUR) } }),
        NOW,
      )?.tone,
    ).toBe("bad");
    expect(
      backupSummary(
        body({
          status: {
            lastSuccess: success(NOW - 2 * HOUR),
            lastFailure: { at: NOW - HOUR, error: "store is full" },
          },
        }),
        NOW,
      ),
    ).toEqual({ text: "The last backup failed 1 hour ago", tone: "bad" });
  });
});

describe("BackupSettings", () => {
  it("renders nothing when backups are not configured", async () => {
    const calls = stubFetch({ "GET /api/backups": [{ configured: false }] });
    const { container } = render(<BackupSettings now={() => NOW} />);
    await waitFor(() => expect(calls).toEqual(["GET /api/backups"]));
    expect(container.innerHTML).toBe("");
  });

  it("shows a failure with its reason, and backs up on request", async () => {
    const calls = stubFetch({
      "GET /api/backups": [
        {
          configured: true,
          overdueAfterMs: 26 * HOUR,
          status: { lastFailure: { at: NOW - HOUR, error: "store is full" } },
        },
        {
          configured: true,
          overdueAfterMs: 26 * HOUR,
          status: { lastSuccess: success(NOW) },
        },
      ],
      "POST /api/backups": [{ started: true }],
    });
    render(<BackupSettings now={() => NOW} />);
    await screen.findByText("The last backup failed 1 hour ago");
    expect(screen.getByText("store is full")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back up now" }));
    await screen.findByText("Backed up just now");
    expect(calls).toContain("POST /api/backups");
  });
});
