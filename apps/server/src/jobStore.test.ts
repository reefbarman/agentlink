import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  JobInputError,
  MAX_RUNS_PER_JOB,
  openJobStore,
  parseJobFields,
  type JobFields,
  type JobRun,
} from "./jobStore.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function tempDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "job-store-"));
  directories.push(directory);
  return path.join(directory, "jobs");
}

const FIELDS: JobFields = {
  name: "Morning brief",
  projectId: "home",
  prompt: "Check the news and brief me",
  schedule: { kind: "daily", time: "07:30", timeZone: "Australia/Sydney" },
  enabled: true,
  approvalMode: "autonomous",
};

const run = (overrides: Partial<JobRun> & { runId: string; jobId: string }) =>
  ({
    projectId: "home",
    trigger: "schedule",
    status: "completed",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }) satisfies JobRun;

describe("job store", () => {
  it("keeps jobs and runs across a reopen", async () => {
    const directory = await tempDirectory();
    const store = await openJobStore({ directory });
    const job = await store.create(FIELDS, 1_000);
    expect(job).toMatchObject({ ...FIELDS, createdAt: 1_000 });
    await store.setNextRunAt(job.id, 5_000);
    await store.saveRun(run({ runId: "r1", jobId: job.id, status: "running" }));
    await store.saveRun(run({ runId: "r1", jobId: job.id, summary: "Done" }));

    const reopened = await openJobStore({ directory });
    expect(reopened.get(job.id)).toMatchObject({ nextRunAt: 5_000 });
    expect(reopened.runs(job.id)).toEqual([
      expect.objectContaining({
        runId: "r1",
        status: "completed",
        summary: "Done",
      }),
    ]);
  });

  it("restarts interval counting when the schedule changes", async () => {
    const store = await openJobStore({ directory: await tempDirectory() });
    const job = await store.create(FIELDS, 1_000);
    await store.setNextRunAt(job.id, 9_000);
    const renamed = await store.update(job.id, { name: "Brief" }, 2_000);
    expect(renamed).toMatchObject({ scheduledFrom: 1_000, nextRunAt: 9_000 });
    const moved = await store.update(
      job.id,
      { schedule: { kind: "interval", everyMinutes: 30 }, model: null },
      3_000,
    );
    expect(moved.scheduledFrom).toBe(3_000);
    expect(moved.nextRunAt).toBeUndefined();
    await expect(store.update("missing", {}, 1)).rejects.toThrow(
      new JobInputError("job_not_found"),
    );
  });

  it("deletes a job with its runs", async () => {
    const directory = await tempDirectory();
    const store = await openJobStore({ directory });
    const job = await store.create(FIELDS, 1);
    await store.saveRun(run({ runId: "r1", jobId: job.id }));
    expect(await store.delete(job.id)).toBe(true);
    expect(await store.delete(job.id)).toBe(false);
    // A late update from a run of the deleted job is dropped.
    await store.saveRun(run({ runId: "r2", jobId: job.id }));
    const reopened = await openJobStore({ directory });
    expect(reopened.list()).toEqual([]);
    expect(reopened.run("r1")).toBeUndefined();
    expect(reopened.run("r2")).toBeUndefined();
  });

  it("keeps the newest runs of each job, never dropping active ones", async () => {
    const directory = await tempDirectory();
    const store = await openJobStore({ directory });
    const job = await store.create(FIELDS, 1);
    await store.saveRun(
      run({ runId: "live", jobId: job.id, status: "running" }),
    );
    for (let index = 0; index < MAX_RUNS_PER_JOB + 5; index += 1) {
      await store.saveRun(run({ runId: `r${index}`, jobId: job.id }));
    }
    const runs = store.runs(job.id);
    expect(runs).toHaveLength(MAX_RUNS_PER_JOB);
    expect(runs[0]!.runId).toBe(`r${MAX_RUNS_PER_JOB + 4}`);
    expect(runs.some((entry) => entry.runId === "live")).toBe(true);
    expect(runs.some((entry) => entry.runId === "r0")).toBe(false);
    const reopened = await openJobStore({ directory });
    expect(reopened.runs(job.id)).toHaveLength(MAX_RUNS_PER_JOB);
  });

  it("skips a torn run line and refuses unreadable definitions", async () => {
    const directory = await tempDirectory();
    const store = await openJobStore({ directory });
    const job = await store.create(FIELDS, 1);
    await store.saveRun(run({ runId: "r1", jobId: job.id }));
    await fs.appendFile(path.join(directory, "runs.jsonl"), '{"runId":"r2"');
    expect((await openJobStore({ directory })).runs(job.id)).toHaveLength(1);

    await fs.writeFile(path.join(directory, "jobs.json"), "{ not json");
    await expect(openJobStore({ directory })).rejects.toThrow(/unreadable/u);
  });

  it("validates job input", () => {
    const parse = (body: Record<string, unknown>) =>
      parseJobFields(body, { partial: false, defaultTimeZone: "UTC" });
    const body = {
      name: "  Brief  ",
      projectId: "home",
      prompt: "Go",
      schedule: { kind: "daily", time: "07:30" },
    };
    expect(parse(body)).toEqual({
      name: "Brief",
      projectId: "home",
      prompt: "Go",
      schedule: { kind: "daily", time: "07:30", timeZone: "UTC" },
      enabled: true,
      approvalMode: "autonomous",
    });
    const fails = (patch: Record<string, unknown>, code: string) =>
      expect(() => parse({ ...body, ...patch })).toThrow(
        new JobInputError(code),
      );
    fails({ name: " " }, "name_invalid");
    fails({ projectId: "../etc" }, "project_invalid");
    fails({ prompt: "" }, "prompt_invalid");
    fails(
      { schedule: { kind: "interval", everyMinutes: 1 } },
      "schedule_interval_invalid",
    );
    fails({ model: "no-slash" }, "model_invalid");
    fails({ reasoningEffort: "extreme" }, "reasoning_effort_invalid");
    fails({ approvalMode: "yolo" }, "approval_mode_invalid");
    fails({ enabled: "yes" }, "enabled_invalid");
    fails({ owner: "someone" }, "job_field_unknown");
    expect(() => parse({ name: "x" })).toThrow(
      new JobInputError("projectId_required"),
    );
    expect(
      parseJobFields(
        { enabled: false, model: null },
        { partial: true, defaultTimeZone: "UTC" },
      ),
    ).toEqual({ enabled: false, model: null });
  });
});
