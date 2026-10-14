import { afterEach, describe, expect, it, vi } from "vitest";
import { createJobTools, describeSchedule } from "./jobTools.js";

import { promises as fs } from "node:fs";
import { isJobChangeDisplay } from "./jobChangeDisplay.js";
import { openJobStore } from "./jobStore.js";
import os from "node:os";
import path from "node:path";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** Monday 12 October 2026, 11:00 in Sydney: today's 07:30 has passed. */
const NOW = Date.UTC(2026, 9, 12, 0, 0);

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "job-tools-"));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await openJobStore({ directory: path.join(dir, "jobs") });
  const runner = {
    jobChanged: vi.fn(async (_jobId: string) => undefined),
    stopJob: vi.fn(async (_jobId: string, _reason: string) => undefined),
  };
  const onChanged = vi.fn();
  let clock = NOW;
  const tools = createJobTools({
    projectId: "home",
    store,
    runner,
    projectIds: () => ["home", "notes"],
    projectLabel: (id) => (id === "home" ? "Home" : undefined),
    models: [
      { providerId: "codex", modelId: "gpt-5", reasoningEfforts: ["low"] },
    ],
    defaultTimeZone: "Australia/Sydney",
    onChanged,
    now: () => clock,
  });
  const byName = (name: string) => {
    const tool = [
      ...(tools.readTools({} as never) as never[]),
      ...(tools.approvalTools.resolveTools({} as never) as never[]),
    ].find(
      (candidate: { definition: { name: string } }) =>
        candidate.definition.name === name,
    ) as
      | {
          validate(input: unknown): { valid: boolean };
          executeValidated(
            input: Record<string, unknown>,
            context: never,
          ): Promise<{ modelContent: unknown; isError?: boolean }>;
        }
      | undefined;
    if (!tool) throw new Error(`no tool ${name}`);
    return tool;
  };
  const prepare = async (toolName: string, input: Record<string, unknown>) =>
    await tools.approvalTools.prepare({ toolName, input } as never);
  /** What runs once the owner allows a prepared change. */
  const approve = async (
    toolName: string,
    approval: Awaited<ReturnType<typeof prepare>>,
  ) => {
    if (approval.decision !== "require_user" || !approval.preparedInput) {
      throw new Error("not awaiting approval");
    }
    const pending = await tools.approvalTools.validatePending?.({
      sessionId: "s",
      toolName,
      input: approval.preparedInput,
    });
    return {
      pending,
      result: await byName(toolName).executeValidated(
        { ...approval.preparedInput },
        {} as never,
      ),
    };
  };
  return {
    store,
    runner,
    onChanged,
    tools,
    byName,
    prepare,
    approve,
    setClock: (at: number) => {
      clock = at;
    },
  };
}

const morning = {
  name: "Morning brief",
  prompt: "Check my calendar and the weather, then brief me.",
  schedule: {
    kind: "weekly",
    days: ["mon", "tue", "wed", "thu", "fri"],
    time: "07:30",
  },
};

describe("job tools", () => {
  it("creates a job only after the owner approves the exact change", async () => {
    const { store, runner, onChanged, prepare, approve, byName } =
      await setup();
    expect(byName("schedule_job").validate(morning).valid).toBe(true);

    const approval = await prepare("schedule_job", morning);
    expect(approval).toMatchObject({
      decision: "require_user",
      summary:
        'Schedule "Morning brief": every weekday at 07:30 (Australia/Sydney)?',
    });
    if (approval.decision !== "require_user") throw new Error("denied");
    expect(isJobChangeDisplay(approval.displayContent)).toBe(true);
    const text = (approval.displayContent as { text: string }).text;
    expect(text).toContain("Project: Home (home)");
    expect(text).toContain(
      "Schedule: every weekday at 07:30 (Australia/Sydney)",
    );
    expect(text).toMatch(
      /First run: Tue,? 13 Oct.*07:30 \(Australia\/Sydney\)/u,
    );
    expect(text).toContain("Approvals: autonomous");
    expect(text).toContain("Model: the project's default");
    expect(text).toContain(morning.prompt);
    // Nothing is stored until it is approved.
    expect(store.list()).toHaveLength(0);

    const { pending, result } = await approve("schedule_job", approval);
    expect(pending).toEqual({ ok: true });
    expect(result.isError).toBeUndefined();
    const [job] = store.list();
    expect(job).toMatchObject({
      name: "Morning brief",
      projectId: "home",
      prompt: morning.prompt,
      enabled: true,
      approvalMode: "autonomous",
      schedule: {
        kind: "weekly",
        days: ["mon", "tue", "wed", "thu", "fri"],
        time: "07:30",
        timeZone: "Australia/Sydney",
      },
    });
    expect(String(result.modelContent)).toContain(`jobId ${job!.id}`);
    expect(runner.jobChanged).toHaveBeenCalledWith(job!.id);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("never applies a change that was not prepared and approved", async () => {
    const { store, byName } = await setup();
    const result = await byName("schedule_job").executeValidated(
      { ...morning },
      {} as never,
    );
    expect(result).toMatchObject({ isError: true });
    expect(store.list()).toHaveLength(0);
    const deleted = await byName("delete_job").executeValidated(
      { jobId: "x" },
      {} as never,
    );
    expect(deleted).toMatchObject({ isError: true });
  });

  it("refuses invalid jobs with reasons the model can act on", async () => {
    const { prepare } = await setup();
    await expect(
      prepare("schedule_job", {
        ...morning,
        schedule: { kind: "interval", everyMinutes: 5 },
      }),
    ).resolves.toEqual({
      decision: "deny",
      reason: expect.stringContaining("from 15 to 10080"),
    });
    await expect(
      prepare("schedule_job", {
        ...morning,
        schedule: { kind: "daily", time: "7:30" },
      }),
    ).resolves.toMatchObject({ reason: expect.stringContaining("HH:MM") });
    await expect(
      prepare("schedule_job", {
        ...morning,
        schedule: { kind: "daily", time: "07:30", timeZone: "Mars/Base" },
      }),
    ).resolves.toMatchObject({ reason: expect.stringContaining("IANA") });
    await expect(
      prepare("schedule_job", { ...morning, projectId: "work" }),
    ).resolves.toMatchObject({
      reason: expect.stringContaining("open projects: home, notes"),
    });
    await expect(
      prepare("schedule_job", { ...morning, model: "codex/gpt-4" }),
    ).resolves.toMatchObject({
      reason: expect.stringContaining("codex/gpt-5"),
    });
    await expect(
      prepare("schedule_job", {
        name: "No prompt",
        schedule: morning.schedule,
      }),
    ).resolves.toMatchObject({
      reason: "prompt is required for a new job",
    });
  });

  it("changes a job as shown, and not if it changed meanwhile", async () => {
    const { store, runner, prepare, approve, setClock } = await setup();
    const job = await store.create(
      {
        name: "Morning brief",
        projectId: "home",
        prompt: "Brief me.",
        schedule: {
          kind: "daily",
          time: "07:30",
          timeZone: "Australia/Sydney",
        },
        enabled: true,
        approvalMode: "autonomous",
      },
      NOW - 1_000,
    );

    await expect(
      prepare("schedule_job", { jobId: job.id, name: "Morning brief" }),
    ).resolves.toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("sets no field"),
    });
    await expect(
      prepare("schedule_job", { jobId: "missing", enabled: false }),
    ).resolves.toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("list_jobs"),
    });

    const pause = await prepare("schedule_job", {
      jobId: job.id,
      enabled: false,
      approvalMode: "ask",
    });
    expect(pause).toMatchObject({
      decision: "require_user",
      summary: 'Change the scheduled job "Morning brief"?',
    });
    const text = (pause as { displayContent: { text: string } }).displayContent
      .text;
    expect(text).toContain("State: on → paused");
    expect(text).toContain("Approvals: autonomous");
    expect(text).toContain("→ ask");

    // Edited in the Jobs view before the owner answered.
    setClock(NOW + 5_000);
    await store.update(job.id, { prompt: "Brief me, briefly." }, NOW + 5_000);
    const stale = await approve("schedule_job", pause);
    expect(stale.pending).toMatchObject({ ok: false });
    expect(stale.result).toMatchObject({ isError: true });
    expect(store.get(job.id)).toMatchObject({
      enabled: true,
      approvalMode: "autonomous",
      prompt: "Brief me, briefly.",
    });

    const retime = await prepare("schedule_job", {
      jobId: job.id,
      schedule: { kind: "interval", everyMinutes: 120 },
    });
    expect(
      (retime as { displayContent: { text: string } }).displayContent.text,
    ).toContain(
      "Schedule: every day at 07:30 (Australia/Sydney) → every 2 hours",
    );
    const applied = await approve("schedule_job", retime);
    expect(applied.result.isError).toBeUndefined();
    expect(store.get(job.id)?.schedule).toEqual({
      kind: "interval",
      everyMinutes: 120,
    });
    expect(runner.jobChanged).toHaveBeenCalledWith(job.id);
  });

  it("deletes a job after approval, stopping any live run", async () => {
    const { store, runner, prepare, approve } = await setup();
    const job = await store.create(
      {
        name: "Tides",
        projectId: "home",
        prompt: "Tides?",
        schedule: { kind: "interval", everyMinutes: 60 },
        enabled: true,
        approvalMode: "autonomous",
      },
      NOW,
    );
    const approval = await prepare("delete_job", { jobId: job.id });
    expect(approval).toMatchObject({
      decision: "require_user",
      summary: 'Delete the scheduled job "Tides"?',
    });
    const { result } = await approve("delete_job", approval);
    expect(String(result.modelContent)).toContain(
      'Deleted the scheduled job "Tides"',
    );
    expect(runner.stopJob).toHaveBeenCalledWith(job.id, "job_deleted");
    expect(store.list()).toHaveLength(0);
  });

  it("lists jobs for the model", async () => {
    const { store, byName } = await setup();
    await expect(
      byName("list_jobs").executeValidated({}, {} as never),
    ).resolves.toMatchObject({ modelContent: "There are no scheduled jobs." });
    const job = await store.create(
      {
        name: "Tides",
        projectId: "notes",
        prompt: "Tides?",
        schedule: { kind: "interval", everyMinutes: 90 },
        enabled: false,
        approvalMode: "ask",
      },
      NOW,
    );
    const listed = String(
      (await byName("list_jobs").executeValidated({}, {} as never))
        .modelContent,
    );
    expect(listed).toContain(`- Tides (jobId ${job.id})`);
    expect(listed).toContain("Project: notes");
    expect(listed).toContain("Schedule: every 90 minutes (paused)");
    expect(listed).toContain("Approvals: ask");
  });

  it("describes schedules in plain words", () => {
    const zone = { time: "18:00", timeZone: "UTC" };
    expect(describeSchedule({ kind: "interval", everyMinutes: 15 })).toBe(
      "every 15 minutes",
    );
    expect(describeSchedule({ kind: "interval", everyMinutes: 60 })).toBe(
      "every hour",
    );
    expect(describeSchedule({ kind: "interval", everyMinutes: 2_880 })).toBe(
      "every 2 days",
    );
    expect(describeSchedule({ kind: "daily", ...zone })).toBe(
      "every day at 18:00 (UTC)",
    );
    expect(
      describeSchedule({ kind: "weekly", days: ["sun", "sat"], ...zone }),
    ).toBe("every weekend at 18:00 (UTC)");
    expect(
      describeSchedule({ kind: "weekly", days: ["mon", "thu"], ...zone }),
    ).toBe("every Mon, Thu at 18:00 (UTC)");
  });
});
