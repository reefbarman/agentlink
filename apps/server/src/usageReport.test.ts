import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { JobRun } from "./jobStore.js";
import { runAssistantServerCli } from "./serverCli.js";
import {
  formatUsageReport,
  readUsageSources,
  summarizeUsage,
  type UsageSources,
} from "./usageReport.js";
import { dayKey } from "./watches.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "usage-report-"));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** 12:00 on 16 October 2026 in Brisbane (UTC+10). */
const NOW = Date.UTC(2026, 9, 16, 2, 0);
const HOUR = 3_600_000;

function run(fields: Partial<JobRun> & Pick<JobRun, "runId">): JobRun {
  return {
    jobId: "briefing",
    projectId: "home",
    trigger: "schedule",
    status: "completed",
    createdAt: NOW,
    updatedAt: NOW,
    ...fields,
  };
}

function sources(overrides: Partial<UsageSources> = {}): UsageSources {
  return {
    timeZone: "Australia/Brisbane",
    inbox: [],
    pushes: [],
    runs: [],
    jobNames: new Map([
      ["briefing", "Morning briefing"],
      ["watch", "Price watch"],
    ]),
    ...overrides,
  };
}

describe("summarizeUsage", () => {
  it("counts by the owner's calendar day, not UTC", () => {
    // 23:30 UTC on the 15th is 09:30 on the 16th in Brisbane.
    const lateUtc = Date.UTC(2026, 9, 15, 23, 30);
    const days = summarizeUsage(
      sources({
        inbox: [
          { kind: "briefing", createdAt: lateUtc },
          { kind: "watch_changed", createdAt: NOW },
          { kind: "watch_changed", createdAt: NOW - 24 * HOUR },
        ],
        pushes: [
          { at: lateUtc, sent: 1, failed: 0, gone: 0 },
          { at: NOW, sent: 0, failed: 1, gone: 0 },
        ],
        runs: [
          run({
            runId: "b1",
            startedAt: lateUtc,
            usage: { requests: 6, inputTokens: 56_000, outputTokens: 500 },
          }),
          run({ runId: "w1", jobId: "watch", createdAt: NOW }),
          run({
            runId: "w2",
            jobId: "watch",
            createdAt: NOW,
            usage: { requests: 1, inputTokens: 6_000, outputTokens: 40 },
          }),
          run({ runId: "gone", jobId: "deleted-job", createdAt: NOW }),
        ],
      }),
      { days: 2, now: NOW },
    );
    expect(days.map((day) => day.day)).toEqual(["2026-10-15", "2026-10-16"]);
    expect(days[0]).toMatchObject({
      inbox: 1,
      inboxByKind: { watch_changed: 1 },
      pushes: 0,
      jobRuns: 0,
    });
    expect(days[1]).toMatchObject({
      inbox: 2,
      inboxByKind: { briefing: 1, watch_changed: 1 },
      pushes: 1,
      pushesNotDelivered: 1,
      jobRuns: 4,
      usage: { requests: 7, inputTokens: 62_000, outputTokens: 540 },
    });
    expect(days[1]!.jobs.map((job) => [job.name, job.runs])).toEqual([
      ["deleted-job", 1],
      ["Morning briefing", 1],
      ["Price watch", 2],
    ]);
  });

  it("leaves out anything older than the days asked for", () => {
    const days = summarizeUsage(
      sources({
        inbox: [{ kind: "briefing", createdAt: NOW - 3 * 24 * HOUR }],
      }),
      { days: 1, now: NOW },
    );
    expect(days).toHaveLength(1);
    expect(days[0]!.inbox).toBe(0);
  });

  it("formats a plain daily summary", () => {
    const text = formatUsageReport(
      summarizeUsage(
        sources({
          inbox: [{ kind: "briefing", createdAt: NOW }],
          pushes: [{ at: NOW, sent: 1, failed: 0, gone: 0 }],
          runs: [
            run({
              runId: "b1",
              usage: { requests: 6, inputTokens: 56_472, outputTokens: 528 },
            }),
          ],
        }),
        { days: 1, now: NOW },
      ),
      "Australia/Brisbane",
    );
    expect(text).toBe(
      [
        "2026-10-16 (Australia/Brisbane)",
        "  Inbox: 1 (briefing 1)",
        "  Pushes: 1 sent",
        "  Jobs: 1 runs, 6 model requests, 56,472 input and 528 output tokens",
        "    Morning briefing: 1 runs, 6 requests, 56,472 in, 528 out",
        "",
      ].join("\n"),
    );
  });
});

describe("readUsageSources", () => {
  it("reads the data files without writing, latest run line winning", async () => {
    const data = path.join(await tempDir(), "data");
    await fs.mkdir(path.join(data, "settings"), { recursive: true });
    await fs.mkdir(path.join(data, "jobs"), { recursive: true });
    await fs.mkdir(path.join(data, "inbox"), { recursive: true });
    await fs.writeFile(
      path.join(data, "settings", "persona.json"),
      JSON.stringify({ settings: { timeZone: "Australia/Brisbane" } }),
    );
    await fs.writeFile(
      path.join(data, "jobs", "jobs.json"),
      JSON.stringify({ jobs: [{ id: "briefing", name: "Morning briefing" }] }),
    );
    const runsFile = path.join(data, "jobs", "runs.jsonl");
    const runsText = [
      JSON.stringify(run({ runId: "b1", status: "running" })),
      JSON.stringify(
        run({
          runId: "b1",
          usage: { requests: 2, inputTokens: 10, outputTokens: 1 },
        }),
      ),
      '{"runId":"torn"',
    ].join("\n");
    await fs.writeFile(runsFile, runsText);
    await fs.writeFile(
      path.join(data, "inbox", "inbox.json"),
      JSON.stringify({
        schemaVersion: 1,
        entries: [{ kind: "briefing", createdAt: NOW, title: "secret" }, {}],
      }),
    );
    const read = await readUsageSources(data);
    expect(read.timeZone).toBe("Australia/Brisbane");
    expect(read.inbox).toEqual([{ kind: "briefing", createdAt: NOW }]);
    expect(read.runs).toHaveLength(1);
    expect(read.runs[0]!.usage?.requests).toBe(2);
    expect(read.jobNames.get("briefing")).toBe("Morning briefing");
    expect(read.pushes).toEqual([]);
    expect(await fs.readFile(runsFile, "utf8")).toBe(runsText);
  });

  it("falls back to UTC and empty lists when nothing is there", async () => {
    const read = await readUsageSources(path.join(await tempDir(), "none"));
    expect(read).toMatchObject({
      timeZone: "UTC",
      inbox: [],
      pushes: [],
      runs: [],
    });
  });
});

describe("agentlink-server usage-report", () => {
  it("prints today's counts and checks --days", async () => {
    const root = await tempDir();
    await fs.mkdir(path.join(root, "projects", "home"), { recursive: true });
    await fs.mkdir(path.join(root, "data", "inbox"), { recursive: true });
    await fs.writeFile(
      path.join(root, "data", "inbox", "inbox.json"),
      JSON.stringify({
        schemaVersion: 1,
        entries: [{ kind: "briefing", createdAt: Date.now() }],
      }),
    );
    const configPath = path.join(root, "server.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        dataRoot: "data",
        listen: { host: "127.0.0.1", port: 8443 },
        publicOrigins: ["https://assistant.home.arpa:8443"],
        tls: { localCa: true },
        defaultModel: { providerId: "codex", modelId: "gpt-6.1-sol" },
        providers: [{ type: "codex", modelIds: ["gpt-6.1-sol"] }],
        projects: [{ id: "home", root: "projects/home" }],
      }),
    );
    const cli = async (...args: string[]) => {
      let stdout = "";
      let logged = "";
      const code = await runAssistantServerCli(
        ["usage-report", "--config", configPath, ...args],
        {
          stdout: (text: string) => {
            stdout += text;
          },
          log: (text: string) => {
            logged += text;
          },
          env: {},
          waitForShutdown: () => new Promise<string>(() => undefined),
        },
      );
      return { code, stdout, logged };
    };
    const today = await cli();
    expect(today.code).toBe(0);
    expect(today.stdout).toContain(`${dayKey(Date.now(), "UTC")} (UTC)`);
    expect(today.stdout).toContain("Inbox: 1 (briefing 1)");
    const week = await cli("--days", "7");
    expect(week.stdout.match(/\(UTC\)/gu)).toHaveLength(7);
    expect((await cli("--days", "0")).code).not.toBe(0);
  });
});
