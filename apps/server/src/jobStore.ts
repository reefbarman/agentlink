import {
  isCoreReasoningEffort,
  type CoreReasoningEffort,
} from "@agentlink/protocol";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { writeFileAtomic } from "./atomicFile.js";
import {
  JobScheduleError,
  parseJobSchedule,
  type JobSchedule,
} from "./jobSchedule.js";
import { PROJECT_ID_PATTERN } from "./projectCatalog.js";
import {
  SESSION_APPROVAL_MODES,
  type SessionApprovalMode,
} from "./SessionApprovalModes.js";

/**
 * Scheduled job definitions and their run history, kept in memory and
 * persisted under `<dataRoot>/jobs/`: `jobs.json` (definitions, replaced
 * atomically) and `runs.jsonl` (run records appended as they change, the
 * latest line per run winning, compacted to the newest runs of each job).
 * One server process holds the data root, so nothing else writes here.
 */

export const MAX_JOBS = 100;
export const MAX_JOB_NAME_LENGTH = 100;
export const MAX_JOB_PROMPT_LENGTH = 20_000;
/** Run records kept per job. */
export const MAX_RUNS_PER_JOB = 50;
const MODEL_KEY_PATTERN = /^[^/\s]{1,128}\/[^\s]{1,256}$/u;

export interface JobFields {
  readonly name: string;
  readonly projectId: string;
  /** The message each run sends to its new chat. */
  readonly prompt: string;
  readonly schedule: JobSchedule;
  readonly enabled: boolean;
  /** `providerId/modelId`; the project's default model when absent. */
  readonly model?: string;
  readonly reasoningEffort?: CoreReasoningEffort;
  /** Same rules as a chat's approval mode. Never widened for a run. */
  readonly approvalMode: SessionApprovalMode;
}

export interface JobDefinition extends JobFields {
  readonly id: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** When the schedule was last set; intervals count from here. */
  readonly scheduledFrom: number;
  /** The next scheduled run, kept so runs missed while down are found. */
  readonly nextRunAt?: number;
}

/** Fields a change may set; `null` clears an optional one. */
export type JobPatch = {
  readonly [K in keyof JobFields]?: K extends "model" | "reasoningEffort"
    ? JobFields[K] | null
    : JobFields[K];
};

export type JobRunStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled"
  /** The server stopped during the run. Never re-run automatically. */
  | "interrupted"
  /** The model provider's sign-in has expired or is missing. */
  | "blocked_auth"
  /** The model provider refused for rate or subscription limits. */
  | "blocked_quota"
  /** Not run: an earlier run was still going, or it was missed. */
  | "skipped";

export const ACTIVE_RUN_STATUSES: readonly JobRunStatus[] = [
  "queued",
  "running",
  "awaiting_approval",
];

export interface JobRun {
  readonly runId: string;
  readonly jobId: string;
  readonly projectId: string;
  /** `catch_up`: one run for occurrences missed while the server was down. */
  readonly trigger: "schedule" | "catch_up" | "manual";
  readonly scheduledFor?: number;
  readonly status: JobRunStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  /** The run's chat. */
  readonly sessionId?: string;
  readonly title?: string;
  /** The final assistant message, shortened. */
  readonly summary?: string;
  /** A stable error code, or why a run was skipped. */
  readonly error?: string;
  /** What actually went wrong, in words (redacted), when it is known. */
  readonly errorDetail?: string;
}

export class JobInputError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "JobInputError";
  }
}

export interface JobStore {
  list(): readonly JobDefinition[];
  get(jobId: string): JobDefinition | undefined;
  create(fields: JobFields, now: number): Promise<JobDefinition>;
  update(jobId: string, patch: JobPatch, now: number): Promise<JobDefinition>;
  setNextRunAt(jobId: string, nextRunAt: number | undefined): Promise<void>;
  /** Removes the job and its run history. */
  delete(jobId: string): Promise<boolean>;
  /** Newest first. */
  runs(jobId: string): readonly JobRun[];
  run(runId: string): JobRun | undefined;
  saveRun(run: JobRun): Promise<void>;
  /** Wait for pending writes. */
  flush(): Promise<void>;
}

interface StoredJobs {
  readonly schemaVersion: 1;
  readonly jobs: readonly JobDefinition[];
}

/**
 * Validate job fields from an untrusted body: all of them for a new job
 * (`partial: false`), or any subset for a change. Unknown keys are refused.
 * Whether the project and model exist is the caller's check.
 */
export function parseJobFields(
  body: Record<string, unknown>,
  options: { readonly partial: true; readonly defaultTimeZone: string },
): JobPatch;
export function parseJobFields(
  body: Record<string, unknown>,
  options: { readonly partial: false; readonly defaultTimeZone: string },
): JobFields;
export function parseJobFields(
  body: Record<string, unknown>,
  options: { readonly partial: boolean; readonly defaultTimeZone: string },
): JobPatch | JobFields {
  const known = new Set([
    "name",
    "projectId",
    "prompt",
    "schedule",
    "enabled",
    "model",
    "reasoningEffort",
    "approvalMode",
  ]);
  if (Object.keys(body).some((key) => !known.has(key))) {
    throw new JobInputError("job_field_unknown");
  }
  const has = (key: string) => body[key] !== undefined;
  const required = (key: string) => {
    if (!options.partial && !has(key)) {
      throw new JobInputError(`${key}_required`);
    }
    return has(key);
  };
  const fields: Record<string, unknown> = {};
  if (required("name")) {
    const name = body.name;
    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.trim().length > MAX_JOB_NAME_LENGTH
    ) {
      throw new JobInputError("name_invalid");
    }
    fields.name = name.trim();
  }
  if (required("projectId")) {
    if (
      typeof body.projectId !== "string" ||
      !PROJECT_ID_PATTERN.test(body.projectId)
    ) {
      throw new JobInputError("project_invalid");
    }
    fields.projectId = body.projectId;
  }
  if (required("prompt")) {
    const prompt = body.prompt;
    if (
      typeof prompt !== "string" ||
      !prompt.trim() ||
      prompt.length > MAX_JOB_PROMPT_LENGTH
    ) {
      throw new JobInputError("prompt_invalid");
    }
    fields.prompt = prompt;
  }
  if (required("schedule")) {
    try {
      fields.schedule = parseJobSchedule(
        body.schedule,
        options.defaultTimeZone,
      );
    } catch (error) {
      if (error instanceof JobScheduleError) {
        throw new JobInputError(error.code);
      }
      throw error;
    }
  }
  if (has("enabled")) {
    if (typeof body.enabled !== "boolean") {
      throw new JobInputError("enabled_invalid");
    }
    fields.enabled = body.enabled;
  } else if (!options.partial) {
    fields.enabled = true;
  }
  if (has("model")) {
    if (body.model === null && options.partial) fields.model = null;
    else if (
      typeof body.model !== "string" ||
      !MODEL_KEY_PATTERN.test(body.model)
    ) {
      throw new JobInputError("model_invalid");
    } else fields.model = body.model;
  }
  if (has("reasoningEffort")) {
    if (body.reasoningEffort === null && options.partial) {
      fields.reasoningEffort = null;
    } else if (
      typeof body.reasoningEffort !== "string" ||
      !isCoreReasoningEffort(body.reasoningEffort)
    ) {
      throw new JobInputError("reasoning_effort_invalid");
    } else fields.reasoningEffort = body.reasoningEffort;
  }
  if (has("approvalMode")) {
    if (
      !SESSION_APPROVAL_MODES.includes(body.approvalMode as SessionApprovalMode)
    ) {
      throw new JobInputError("approval_mode_invalid");
    }
    fields.approvalMode = body.approvalMode;
  } else if (!options.partial) {
    fields.approvalMode = "autonomous";
  }
  return fields as JobPatch | JobFields;
}

export function isActiveRun(run: JobRun): boolean {
  return ACTIVE_RUN_STATUSES.includes(run.status);
}

/**
 * Load the job store. A missing directory is an empty store; an unreadable
 * `jobs.json` stops the server rather than silently dropping jobs. Torn or
 * unreadable run lines (a crash mid-append) are skipped.
 */
export async function openJobStore(options: {
  readonly directory: string;
}): Promise<JobStore> {
  const jobsFile = path.join(options.directory, "jobs.json");
  const runsFile = path.join(options.directory, "runs.jsonl");
  const jobs = new Map<string, JobDefinition>();
  for (const job of await readJobs(jobsFile)) jobs.set(job.id, job);
  /** Latest record of each run, by job, oldest first. */
  const runsByJob = new Map<string, JobRun[]>();
  const runsById = new Map<string, JobRun>();
  let runLines = 0;
  const remember = (run: JobRun) => {
    const list = runsByJob.get(run.jobId) ?? [];
    const index = list.findIndex((entry) => entry.runId === run.runId);
    if (index >= 0) list[index] = run;
    else list.push(run);
    // Oldest finished runs go first; active ones are never dropped.
    while (list.length > MAX_RUNS_PER_JOB) {
      const drop = list.findIndex((entry) => !isActiveRun(entry));
      if (drop < 0) break;
      runsById.delete(list[drop]!.runId);
      list.splice(drop, 1);
    }
    runsByJob.set(run.jobId, list);
    runsById.set(run.runId, run);
  };
  for (const run of await readRuns(runsFile)) {
    runLines += 1;
    if (jobs.has(run.jobId)) remember(run);
  }

  let writes: Promise<void> = Promise.resolve();
  /** Run the write after earlier ones; a failure does not block later ones. */
  const enqueue = (write: () => Promise<void>): Promise<void> => {
    const next = writes.then(async () => {
      await fs.mkdir(options.directory, { recursive: true, mode: 0o700 });
      await write();
    });
    writes = next.catch(() => undefined);
    return next;
  };
  const persistJobs = () => {
    const content: StoredJobs = { schemaVersion: 1, jobs: [...jobs.values()] };
    return enqueue(() =>
      writeFileAtomic(jobsFile, `${JSON.stringify(content, null, 2)}\n`),
    );
  };
  const compactRuns = () =>
    enqueue(async () => {
      const kept = [...runsByJob.values()].flat();
      await writeFileAtomic(
        runsFile,
        kept.map((run) => `${JSON.stringify(run)}\n`).join(""),
      );
      runLines = kept.length;
    });
  if (runLines > runsById.size * 2 + 100) await compactRuns();

  const requireJob = (jobId: string) => {
    const job = jobs.get(jobId);
    if (!job) throw new JobInputError("job_not_found");
    return job;
  };

  return {
    list: () => [...jobs.values()],
    get: (jobId) => jobs.get(jobId),
    async create(fields, now) {
      if (jobs.size >= MAX_JOBS) throw new JobInputError("job_limit_reached");
      const job: JobDefinition = {
        ...fields,
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
        scheduledFrom: now,
      };
      jobs.set(job.id, job);
      await persistJobs();
      return job;
    },
    async update(jobId, patch, now) {
      const current = requireJob(jobId);
      const next: Record<string, unknown> = { ...current };
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete next[key];
        else if (value !== undefined) next[key] = value;
      }
      next.updatedAt = now;
      if (
        patch.schedule &&
        JSON.stringify(patch.schedule) !== JSON.stringify(current.schedule)
      ) {
        next.scheduledFrom = now;
        delete next.nextRunAt;
      }
      const job = next as unknown as JobDefinition;
      jobs.set(jobId, job);
      await persistJobs();
      return job;
    },
    async setNextRunAt(jobId, nextRunAt) {
      const current = jobs.get(jobId);
      if (!current || current.nextRunAt === nextRunAt) return;
      const { nextRunAt: _previous, ...rest } = current;
      jobs.set(jobId, nextRunAt === undefined ? rest : { ...rest, nextRunAt });
      await persistJobs();
    },
    async delete(jobId) {
      if (!jobs.delete(jobId)) return false;
      for (const run of runsByJob.get(jobId) ?? []) runsById.delete(run.runId);
      runsByJob.delete(jobId);
      await persistJobs();
      await compactRuns();
      return true;
    },
    runs: (jobId) => [...(runsByJob.get(jobId) ?? [])].reverse(),
    run: (runId) => runsById.get(runId),
    async saveRun(run) {
      // A run of a deleted job is not recorded again.
      if (!jobs.has(run.jobId)) return;
      remember(run);
      await enqueue(async () => {
        await fs.appendFile(runsFile, `${JSON.stringify(run)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        runLines += 1;
      });
      if (runLines > runsById.size * 2 + 100) await compactRuns();
    },
    async flush() {
      await writes;
    },
  };
}

async function readJobs(file: string): Promise<JobDefinition[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let parsed: Partial<StoredJobs> | undefined;
  try {
    parsed = JSON.parse(raw) as Partial<StoredJobs>;
  } catch {
    parsed = undefined;
  }
  if (
    !parsed ||
    parsed.schemaVersion !== 1 ||
    !Array.isArray(parsed.jobs) ||
    !parsed.jobs.every(isStoredJob)
  ) {
    throw new Error(
      `Scheduled jobs are unreadable: ${file}. Fix or remove it (removing deletes every job).`,
    );
  }
  return [...parsed.jobs];
}

function isStoredJob(value: unknown): value is JobDefinition {
  if (!value || typeof value !== "object") return false;
  const job = value as Record<string, unknown>;
  if (
    typeof job.id !== "string" ||
    typeof job.createdAt !== "number" ||
    typeof job.updatedAt !== "number" ||
    typeof job.scheduledFrom !== "number" ||
    (job.nextRunAt !== undefined && typeof job.nextRunAt !== "number")
  ) {
    return false;
  }
  const {
    id: _id,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    scheduledFrom: _scheduledFrom,
    nextRunAt: _nextRunAt,
    ...fields
  } = job;
  try {
    // Stored schedules carry their time zone, so the default is unused.
    parseJobFields(fields, { partial: false, defaultTimeZone: "UTC" });
    return typeof fields.enabled === "boolean";
  } catch {
    return false;
  }
}

async function readRuns(file: string): Promise<JobRun[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const runs: JobRun[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const run = JSON.parse(line) as JobRun;
      if (
        typeof run.runId === "string" &&
        typeof run.jobId === "string" &&
        typeof run.status === "string"
      ) {
        runs.push(run);
      }
    } catch {
      // A torn final line from a crash mid-append.
    }
  }
  return runs;
}
