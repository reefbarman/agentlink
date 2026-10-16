import { promises as fs } from "node:fs";
import path from "node:path";

import type { InboxEntry } from "./inboxStore.js";
import type { JobRun, JobRunUsage } from "./jobStore.js";
import { readPushLog, type PushLogEntry } from "./pushLog.js";
import { dayKey } from "./watches.js";

/**
 * Per-day counts for the owner: Inbox entries, push notifications, and the
 * scheduled jobs' runs and model use, by the owner's calendar day. Reads the
 * data files directly and never writes, so it is safe beside a running
 * server (opening the stores would compact them).
 *
 * The inputs are bounded (Inbox 500 entries, 50 runs per job, deleted
 * chats take their Inbox entries), so a long series needs a daily snapshot
 * of the report rather than one report at the end.
 */

export interface JobDayUsage extends JobRunUsage {
  readonly name: string;
  readonly runs: number;
}

export interface DayUsage {
  /** `YYYY-MM-DD` in the owner's time zone. */
  readonly day: string;
  readonly inbox: number;
  readonly inboxByKind: Readonly<Record<string, number>>;
  /** Notifications that reached at least one device. */
  readonly pushes: number;
  /** Notifications no device took (failed, or no device subscribed). */
  readonly pushesNotDelivered: number;
  readonly jobRuns: number;
  readonly usage: JobRunUsage;
  readonly jobs: readonly JobDayUsage[];
}

export interface UsageSources {
  readonly timeZone: string;
  readonly inbox: readonly Pick<InboxEntry, "kind" | "createdAt">[];
  readonly pushes: readonly PushLogEntry[];
  readonly runs: readonly JobRun[];
  /** Job names by ID; deleted jobs show their ID. */
  readonly jobNames: ReadonlyMap<string, string>;
}

/** The last `days` calendar days, oldest first, ending with today's. */
export function summarizeUsage(
  sources: UsageSources,
  options: { readonly days: number; readonly now: number },
): DayUsage[] {
  // Half-day steps back from now, so a daylight-saving shift never skips a day.
  const days: string[] = [];
  for (let at = options.now; days.length < options.days; at -= 43_200_000) {
    const key = dayKey(at, sources.timeZone);
    if (!days.includes(key)) days.unshift(key);
  }
  const wanted = new Set(days);
  const of = (at: number) => {
    const key = dayKey(at, sources.timeZone);
    return wanted.has(key) ? key : undefined;
  };

  const inbox = new Map<string, Map<string, number>>();
  for (const entry of sources.inbox) {
    const day = of(entry.createdAt);
    if (!day) continue;
    const kinds = inbox.get(day) ?? new Map<string, number>();
    kinds.set(entry.kind, (kinds.get(entry.kind) ?? 0) + 1);
    inbox.set(day, kinds);
  }

  const pushes = new Map<string, { sent: number; not: number }>();
  for (const entry of sources.pushes) {
    const day = of(entry.at);
    if (!day) continue;
    const counts = pushes.get(day) ?? { sent: 0, not: 0 };
    if (entry.sent > 0) counts.sent += 1;
    else counts.not += 1;
    pushes.set(day, counts);
  }

  const jobs = new Map<string, Map<string, JobDayUsage>>();
  for (const run of sources.runs) {
    const day = of(run.startedAt ?? run.createdAt);
    if (!day) continue;
    const byJob = jobs.get(day) ?? new Map<string, JobDayUsage>();
    const before = byJob.get(run.jobId) ?? {
      name: sources.jobNames.get(run.jobId) ?? run.jobId,
      runs: 0,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    byJob.set(run.jobId, {
      name: before.name,
      runs: before.runs + 1,
      requests: before.requests + (run.usage?.requests ?? 0),
      inputTokens: before.inputTokens + (run.usage?.inputTokens ?? 0),
      outputTokens: before.outputTokens + (run.usage?.outputTokens ?? 0),
    });
    jobs.set(day, byJob);
  }

  return days.map((day) => {
    const kinds = inbox.get(day) ?? new Map<string, number>();
    const pushed = pushes.get(day) ?? { sent: 0, not: 0 };
    const dayJobs = [...(jobs.get(day)?.values() ?? [])].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    const total = (field: keyof JobRunUsage | "runs") =>
      dayJobs.reduce((sum, job) => sum + job[field], 0);
    return {
      day,
      inbox: [...kinds.values()].reduce((sum, count) => sum + count, 0),
      inboxByKind: Object.fromEntries(
        [...kinds.entries()].sort(([a], [b]) => a.localeCompare(b)),
      ),
      pushes: pushed.sent,
      pushesNotDelivered: pushed.not,
      jobRuns: total("runs"),
      usage: {
        requests: total("requests"),
        inputTokens: total("inputTokens"),
        outputTokens: total("outputTokens"),
      },
      jobs: dayJobs,
    };
  });
}

const number = (value: number) => value.toLocaleString("en-AU");

export function formatUsageReport(
  days: readonly DayUsage[],
  timeZone: string,
): string {
  const lines: string[] = [];
  for (const day of days) {
    const kinds = Object.entries(day.inboxByKind)
      .map(([kind, count]) => `${kind} ${count}`)
      .join(", ");
    lines.push(
      `${day.day} (${timeZone})`,
      `  Inbox: ${day.inbox}${kinds ? ` (${kinds})` : ""}`,
      `  Pushes: ${day.pushes} sent${day.pushesNotDelivered ? `, ${day.pushesNotDelivered} not delivered` : ""}`,
      `  Jobs: ${day.jobRuns} runs, ${number(day.usage.requests)} model requests, ${number(day.usage.inputTokens)} input and ${number(day.usage.outputTokens)} output tokens`,
    );
    for (const job of day.jobs) {
      lines.push(
        `    ${job.name}: ${job.runs} runs, ${number(job.requests)} requests, ${number(job.inputTokens)} in, ${number(job.outputTokens)} out`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Read everything the report needs from a data root, without writing. */
export async function readUsageSources(
  dataRoot: string,
): Promise<UsageSources> {
  const persona = await readJson(
    path.join(dataRoot, "settings", "persona.json"),
  );
  const zone = (persona?.settings as { timeZone?: unknown } | undefined)
    ?.timeZone;
  const inboxFile = await readJson(path.join(dataRoot, "inbox", "inbox.json"));
  const jobsFile = await readJson(path.join(dataRoot, "jobs", "jobs.json"));
  const jobNames = new Map<string, string>();
  for (const job of arrayOf(jobsFile?.jobs)) {
    if (typeof job.id === "string" && typeof job.name === "string") {
      jobNames.set(job.id, job.name);
    }
  }
  return {
    timeZone: typeof zone === "string" && validZone(zone) ? zone : "UTC",
    inbox: arrayOf(inboxFile?.entries).flatMap((entry) =>
      typeof entry.kind === "string" && typeof entry.createdAt === "number"
        ? [
            {
              kind: entry.kind as InboxEntry["kind"],
              createdAt: entry.createdAt,
            },
          ]
        : [],
    ),
    pushes: await readPushLog(path.join(dataRoot, "push", "deliveries.jsonl")),
    runs: await readLatestRuns(path.join(dataRoot, "jobs", "runs.jsonl")),
    jobNames,
  };
}

/** The latest line of each run wins, as in the job store. */
async function readLatestRuns(file: string): Promise<JobRun[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const runs = new Map<string, JobRun>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const run = JSON.parse(line) as JobRun;
      if (
        typeof run.runId === "string" &&
        typeof run.jobId === "string" &&
        typeof run.createdAt === "number"
      ) {
        runs.set(run.runId, run);
      }
    } catch {
      // A torn final line from a crash mid-append.
    }
  }
  return [...runs.values()];
}

async function readJson(
  file: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function arrayOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object",
      )
    : [];
}

function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
