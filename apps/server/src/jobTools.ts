import {
  defineTool,
  type HostTool,
  type HostToolResolver,
  type HostToolResult,
} from "@agentlink/core";
import type {
  WorkspaceApprovalHostTools,
  WorkspaceHostToolApproval,
} from "@agentlink/workspace-host";

import {
  JOB_CHANGE_DISPLAY_KIND,
  type JobChangeDisplay,
} from "./jobChangeDisplay.js";
import { jobRunnableError, modelsByKey } from "./jobRoutes.js";
import { currentModels, type ModelChoices } from "./liveModels.js";
import type { JobRunner } from "./jobRunner.js";
import {
  MIN_INTERVAL_MINUTES,
  MAX_INTERVAL_MINUTES,
  WEEKDAYS,
  nextOccurrence,
  type JobSchedule,
} from "./jobSchedule.js";
import {
  JobInputError,
  MAX_JOBS,
  MAX_JOB_NAME_LENGTH,
  parseJobFields,
  type JobDefinition,
  type JobFields,
  type JobPatch,
  type JobStore,
} from "./jobStore.js";
import { SESSION_APPROVAL_MODES } from "./SessionApprovalModes.js";
import {
  BRIEFING_SECTIONS,
  DEFAULT_BRIEFING_WORDS,
  MAX_BRIEFING_TOPICS,
  MAX_BRIEFING_WORDS,
  MIN_BRIEFING_WORDS,
  describeBriefingSections,
  type BriefingSpec,
} from "./briefingSpec.js";
import {
  DEFAULT_WATCH_NOTIFY_PER_DAY,
  MAX_WATCH_NOTIFY_PER_DAY,
  type WatchTarget,
} from "./watchTarget.js";

/**
 * Chat tools for scheduled jobs:
 *
 * - `list_jobs` reads the jobs, with no approval.
 * - `schedule_job` creates or changes a job, `watch_page` creates or changes
 *   a watch (a job that checks a page and only asks a model when it
 *   changed), and `delete_job` deletes either.
 *   All always stop for the owner's approval, whatever the chat's approval
 *   mode: the card shows the exact project, schedule, settings and prompt,
 *   and exactly that change is applied once approved. Nothing is stored
 *   before then. A job changed or deleted elsewhere in the meantime is not
 *   touched.
 */

export const JOB_TOOL_NAMES = [
  "schedule_job",
  "watch_page",
  "schedule_briefing",
  "delete_job",
] as const;
/** How often a new watch checks, unless asked otherwise. */
export const DEFAULT_WATCH_INTERVAL_MINUTES = 60;
/** When a new briefing arrives, unless asked otherwise (owner's time zone). */
export const DEFAULT_BRIEFING_TIME = "07:00";
const DEFAULT_BRIEFING_NAME = "Daily briefing";
const DEFAULT_BRIEFING_NOTES = "Keep it friendly and to the point.";

/** What a job is, in words. */
function jobNoun(job: Pick<JobFields, "watch" | "briefing">): string {
  return job.watch ? "watch" : job.briefing ? "briefing" : "scheduled job";
}
/** Shorter than the API's limit so the approval card shows all of it. */
export const MAX_TOOL_PROMPT_LENGTH = 3_000;
const MAX_LISTED_MODELS = 20;

export interface JobToolsOptions {
  /** The chat's project: new jobs go here unless another is named. */
  readonly projectId: string;
  readonly store: JobStore;
  readonly runner: Pick<JobRunner, "jobChanged" | "stopJob">;
  /** Projects open on this server. */
  readonly projectIds: () => readonly string[];
  readonly projectLabel?: (projectId: string) => string | undefined;
  readonly models: ModelChoices;
  /** For daily and weekly schedules that name no time zone. */
  readonly defaultTimeZone: string;
  /** After a job is created, changed or deleted. */
  readonly onChanged?: () => void;
  readonly now?: () => number;
}

export interface JobTools {
  /** `list_jobs`: read-only, offered every turn. */
  readonly readTools: HostToolResolver;
  /** `schedule_job` and `delete_job`: each call needs the owner. */
  readonly approvalTools: WorkspaceApprovalHostTools;
}

/** The exact change the owner approved; what the tool then applies. */
type PreparedChange =
  | { readonly action: "create"; readonly fields: JobFields }
  | {
      readonly action: "update";
      readonly jobId: string;
      readonly expectedUpdatedAt: number;
      readonly patch: JobPatch;
    }
  | {
      readonly action: "delete";
      readonly jobId: string;
      readonly expectedUpdatedAt: number;
    };

export function createJobTools(options: JobToolsOptions): JobTools {
  const { store, runner } = options;
  const now = options.now ?? Date.now;
  const models = () => modelsByKey(currentModels(options.models));
  const hasProject = (projectId: string) =>
    options.projectIds().includes(projectId);
  const projectName = (projectId: string) => {
    const label = options.projectLabel?.(projectId);
    return label && label !== projectId ? `${label} (${projectId})` : projectId;
  };

  const explain = (code: string, projectId?: string): string => {
    switch (code) {
      case "name_required":
      case "prompt_required":
      case "schedule_required":
        return `${code.replace("_required", "")} is required for a new job`;
      case "name_invalid":
        return `name must be 1 to ${MAX_JOB_NAME_LENGTH} characters`;
      case "prompt_invalid":
        return "prompt must not be empty";
      case "project_invalid":
      case "project_not_found":
        return `project${projectId ? ` "${projectId}"` : ""} is not open on this server; open projects: ${options.projectIds().join(", ") || "none"}`;
      case "schedule_invalid":
        return 'schedule must be {"kind":"interval","everyMinutes":N}, {"kind":"daily","time":"HH:MM","timeZone"?}, or {"kind":"weekly","days":["mon",…],"time":"HH:MM","timeZone"?}';
      case "schedule_interval_invalid":
        return `everyMinutes must be a whole number from ${MIN_INTERVAL_MINUTES} to ${MAX_INTERVAL_MINUTES} (7 days)`;
      case "schedule_days_invalid":
        return `days must be a non-empty list of ${WEEKDAYS.map((day) => `"${day}"`).join(", ")}`;
      case "schedule_time_invalid":
        return 'time must be 24-hour "HH:MM", for example "07:30"';
      case "schedule_time_zone_invalid":
        return 'timeZone must be an IANA name such as "Australia/Sydney"';
      case "model_invalid":
      case "model_not_available":
        return `model must be one of: ${[...models().keys()].slice(0, MAX_LISTED_MODELS).join(", ")}; omit it to use the project's default`;
      case "reasoning_effort_invalid":
      case "reasoning_effort_not_available":
        return "that reasoning effort is not offered for this model; omit it to use the default";
      case "approval_mode_invalid":
        return `approvalMode must be ${SESSION_APPROVAL_MODES.map((mode) => `"${mode}"`).join(" or ")}`;
      case "enabled_invalid":
        return "enabled must be true or false";
      case "job_field_unknown":
        return "unknown field";
      case "job_limit_reached":
        return `there are already ${MAX_JOBS} jobs; delete one first`;
      case "job_not_found":
        return "no job has that jobId; call list_jobs for the current ones";
      case "job_changed":
        return "the job was changed or deleted after this was proposed; call list_jobs and propose the change again";
      case "nothing_to_change":
        return "the change sets no field; pass the fields to change";
      case "watch_invalid":
      case "watch_url_invalid":
        return "url must be an absolute https (or http) address of a public page or RSS/Atom feed, on the standard port";
      case "watch_selector_invalid":
        return 'selector must be one simple CSS selector: a tag, "#id", ".class" or a mix such as "div.release"; omit it for the page\'s main text';
      case "watch_notify_invalid":
        return `notifyPerDay must be a whole number from 0 to ${MAX_WATCH_NOTIFY_PER_DAY}`;
      case "not_a_watch":
        return "that job is not a watch; change it with the tool that made it";
      case "not_a_briefing":
        return "that job is not a briefing; change it with the tool that made it";
      case "briefing_invalid":
      case "briefing_sections_invalid":
        return `sections must be a non-empty list of distinct ${BRIEFING_SECTIONS.map((section) => `"${section}"`).join(", ")}`;
      case "briefing_topics_invalid":
        return `topics must be at most ${MAX_BRIEFING_TOPICS} short phrases (up to 80 characters each)`;
      case "briefing_length_invalid":
        return `maxWords must be a whole number from ${MIN_BRIEFING_WORDS} to ${MAX_BRIEFING_WORDS}`;
      case "job_kind_conflict":
        return "a job is a watch or a briefing, not both";
      default:
        return code;
    }
  };

  /** Throws `JobInputError` when the job could not run here. */
  const assertRunnable = (fields: {
    readonly projectId: string;
    readonly model?: string;
    readonly reasoningEffort?: string;
  }) => {
    const error = jobRunnableError(fields, { hasProject, models: models() });
    if (error) throw new JobInputError(error);
  };

  const requireJob = (jobId: unknown): JobDefinition => {
    const job = typeof jobId === "string" ? store.get(jobId) : undefined;
    if (!job) throw new JobInputError("job_not_found");
    return job;
  };

  /** The job a change would leave, to check it can still run. */
  const merged = (current: JobDefinition, patch: JobPatch) => {
    const model =
      patch.model === null ? undefined : (patch.model ?? current.model);
    const reasoningEffort =
      patch.reasoningEffort === null
        ? undefined
        : (patch.reasoningEffort ?? current.reasoningEffort);
    return {
      projectId: patch.projectId ?? current.projectId,
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    };
  };

  const describeJob = (fields: JobFields, at: number): string[] =>
    fields.briefing
      ? [
          `Name: ${fields.name}`,
          `Arrives: ${describeSchedule(fields.schedule)}`,
          `Sections: ${describeBriefingSections(fields.briefing.sections)}`,
          ...(fields.briefing.sections.includes("news")
            ? [
                `News topics: ${fields.briefing.topics.length > 0 ? fields.briefing.topics.join(", ") : "none yet"}`,
              ]
            : []),
          `Length: about ${fields.briefing.maxWords} words, every item with a source link`,
          fields.enabled
            ? `First briefing: ${formatInstant(firstRun(fields.schedule, at), timeZoneOf(fields.schedule, options.defaultTimeZone))}`
            : "Paused: it will not arrive until it is turned on",
          `Project: ${projectName(fields.projectId)}`,
          "Your notes:",
          fields.prompt,
        ]
      : fields.watch
        ? [
            `Name: ${fields.name}`,
            `Page: ${fields.watch.url}`,
            `Part of the page: ${fields.watch.selector ? `elements matching "${fields.watch.selector}"` : "its main text (or a feed's items)"}`,
            `Checks: ${describeSchedule(fields.schedule)}, without a model; a model is asked only when it changed`,
            `Tells you: ${describeNotifyCap(fields.watch.notifyPerDay)}`,
            fields.enabled
              ? `First check: ${formatInstant(firstRun(fields.schedule, at), timeZoneOf(fields.schedule, options.defaultTimeZone))}`
              : "Paused: it will not check until it is turned on",
            `Project: ${projectName(fields.projectId)}`,
            "What matters:",
            fields.prompt,
          ]
        : [
            `Name: ${fields.name}`,
            `Project: ${projectName(fields.projectId)}`,
            `Schedule: ${describeSchedule(fields.schedule)}`,
            fields.enabled
              ? `First run: ${formatInstant(firstRun(fields.schedule, at), timeZoneOf(fields.schedule, options.defaultTimeZone))}`
              : "Paused: it will not run until it is turned on",
            `Approvals: ${describeApprovalMode(fields.approvalMode)}`,
            `Model: ${fields.model ?? "the project's default"}${fields.reasoningEffort ? `, reasoning ${fields.reasoningEffort}` : ""}`,
            "Prompt for each run:",
            fields.prompt,
          ];

  const describeChanges = (
    current: JobDefinition,
    patch: JobPatch,
    at: number,
  ): string[] => {
    const lines: string[] = [];
    const change = (label: string, from: string, to: string) => {
      if (from !== to) lines.push(`${label}: ${from} → ${to}`);
    };
    if (patch.name !== undefined) change("Name", current.name, patch.name);
    if (patch.projectId !== undefined) {
      change(
        "Project",
        projectName(current.projectId),
        projectName(patch.projectId),
      );
    }
    if (patch.schedule !== undefined) {
      change(
        "Schedule",
        describeSchedule(current.schedule),
        describeSchedule(patch.schedule),
      );
    }
    if (patch.enabled !== undefined) {
      change(
        "State",
        current.enabled ? "on" : "paused",
        patch.enabled ? "on" : "paused",
      );
    }
    if (patch.approvalMode !== undefined) {
      change(
        "Approvals",
        describeApprovalMode(current.approvalMode),
        describeApprovalMode(patch.approvalMode),
      );
    }
    if (patch.model !== undefined) {
      change(
        "Model",
        current.model ?? "project default",
        patch.model ?? "project default",
      );
    }
    if (patch.reasoningEffort !== undefined) {
      change(
        "Reasoning",
        current.reasoningEffort ?? "default",
        patch.reasoningEffort ?? "default",
      );
    }
    if (patch.watch !== undefined && current.watch) {
      change("Page", current.watch.url, patch.watch.url);
      change(
        "Part of the page",
        current.watch.selector ?? "main text",
        patch.watch.selector ?? "main text",
      );
      change(
        "Tells you",
        describeNotifyCap(current.watch.notifyPerDay),
        describeNotifyCap(patch.watch.notifyPerDay),
      );
    }
    if (patch.briefing !== undefined && current.briefing) {
      change(
        "Sections",
        describeBriefingSections(current.briefing.sections),
        describeBriefingSections(patch.briefing.sections),
      );
      change(
        "News topics",
        current.briefing.topics.join(", ") || "none",
        patch.briefing.topics.join(", ") || "none",
      );
      change(
        "Length",
        `about ${current.briefing.maxWords} words`,
        `about ${patch.briefing.maxWords} words`,
      );
    }
    if (patch.prompt !== undefined && patch.prompt !== current.prompt) {
      lines.push(
        current.watch
          ? "New note on what matters:"
          : current.briefing
            ? "New notes:"
            : "New prompt for each run:",
        patch.prompt,
      );
    }
    const schedule = patch.schedule ?? current.schedule;
    const enabled = patch.enabled ?? current.enabled;
    if (lines.length > 0 && enabled && patch.schedule !== undefined) {
      lines.push(
        `Next run: ${formatInstant(firstRun(schedule, at), timeZoneOf(schedule, options.defaultTimeZone))}`,
      );
    }
    return lines;
  };

  const prepare = (
    toolName: string,
    input: Readonly<Record<string, unknown>>,
  ): WorkspaceHostToolApproval => {
    const at = now();
    try {
      if (toolName === "delete_job") {
        const job = requireJob(input.jobId);
        const display: JobChangeDisplay = {
          kind: JOB_CHANGE_DISPLAY_KIND,
          action: "delete",
          jobName: job.name,
          text: [
            "Delete this scheduled job and its run history (its run chats stay).",
            "",
            ...describeJob(job, at).slice(0, 3),
          ].join("\n"),
        };
        return {
          decision: "require_user",
          summary: `Delete the scheduled job "${job.name}"?`,
          displayContent: display,
          preparedInput: preparedInput({
            action: "delete",
            jobId: job.id,
            expectedUpdatedAt: job.updatedAt,
          }),
        };
      }
      const { jobId, ...body } =
        toolName === "watch_page"
          ? watchInput(input)
          : toolName === "schedule_briefing"
            ? briefingInput(input)
            : input;
      if (jobId !== undefined) {
        const current = requireJob(jobId);
        const patch = parseJobFields(body, {
          partial: true,
          defaultTimeZone: options.defaultTimeZone,
        });
        assertRunnable(merged(current, patch));
        const changes = describeChanges(current, patch, at);
        if (changes.length === 0) throw new JobInputError("nothing_to_change");
        const noun = jobNoun(current);
        const display: JobChangeDisplay = {
          kind: JOB_CHANGE_DISPLAY_KIND,
          action: "update",
          jobName: current.name,
          text: [`Change the ${noun} "${current.name}":`, "", ...changes].join(
            "\n",
          ),
        };
        return {
          decision: "require_user",
          summary: `Change the ${noun} "${current.name}"?`,
          displayContent: display,
          preparedInput: preparedInput({
            action: "update",
            jobId: current.id,
            expectedUpdatedAt: current.updatedAt,
            patch,
          }),
        };
      }
      const fields = parseJobFields(
        { projectId: options.projectId, ...body },
        { partial: false, defaultTimeZone: options.defaultTimeZone },
      );
      assertRunnable(fields);
      if (store.list().length >= MAX_JOBS) {
        throw new JobInputError("job_limit_reached");
      }
      const display: JobChangeDisplay = {
        kind: JOB_CHANGE_DISPLAY_KIND,
        action: "create",
        jobName: fields.name,
        text: [
          fields.watch
            ? "Watch a page:"
            : fields.briefing
              ? "Schedule a briefing:"
              : "Create a scheduled job:",
          "",
          ...describeJob(fields, at),
        ].join("\n"),
      };
      return {
        decision: "require_user",
        summary: fields.watch
          ? `Watch "${fields.name}": ${fields.watch.url}?`
          : fields.briefing
            ? `Brief you "${fields.name}": ${describeSchedule(fields.schedule)}?`
            : `Schedule "${fields.name}": ${describeSchedule(fields.schedule)}?`,
        displayContent: display,
        preparedInput: preparedInput({ action: "create", fields }),
      };
    } catch (error) {
      if (error instanceof JobInputError) {
        return {
          decision: "deny",
          reason: explain(
            error.code,
            typeof input.projectId === "string" ? input.projectId : undefined,
          ),
        };
      }
      throw error;
    }
  };

  /** Whether an approved change still applies to the jobs as they are. */
  const stillApplies = (change: PreparedChange): string | undefined => {
    if (change.action === "create") {
      if (store.list().length >= MAX_JOBS) return explain("job_limit_reached");
      const error = jobRunnableError(change.fields, {
        hasProject,
        models: models(),
      });
      return error ? explain(error, change.fields.projectId) : undefined;
    }
    const current = store.get(change.jobId);
    if (!current || current.updatedAt !== change.expectedUpdatedAt) {
      return explain("job_changed");
    }
    if (change.action === "update") {
      const error = jobRunnableError(merged(current, change.patch), {
        hasProject,
        models: models(),
      });
      return error ? explain(error) : undefined;
    }
    return undefined;
  };

  const apply = async (change: PreparedChange): Promise<HostToolResult> => {
    const stale = stillApplies(change);
    if (stale) return failure(`Not applied: ${stale}`);
    try {
      switch (change.action) {
        case "create": {
          const job = await store.create(change.fields, now());
          await runner.jobChanged(job.id);
          options.onChanged?.();
          return applied(store.get(job.id) ?? job, "Created");
        }
        case "update": {
          const job = await store.update(change.jobId, change.patch, now());
          // Pausing stops a live run; a new schedule starts counting now.
          await runner.jobChanged(job.id);
          options.onChanged?.();
          return applied(store.get(job.id) ?? job, "Changed");
        }
        case "delete": {
          const job = store.get(change.jobId);
          await runner.stopJob(change.jobId, "job_deleted");
          await store.delete(change.jobId);
          await runner.jobChanged(change.jobId);
          options.onChanged?.();
          return {
            modelContent: `Deleted the scheduled job "${job?.name ?? change.jobId}".`,
            displayContent: { jobId: change.jobId, action: "delete" },
          };
        }
      }
    } catch (error) {
      if (error instanceof JobInputError) {
        return failure(`Not applied: ${explain(error.code)}`);
      }
      throw error;
    }
  };

  const applied = (job: JobDefinition, verb: string): HostToolResult => ({
    modelContent: [
      `${verb} the ${jobNoun(job)} "${job.name}" (jobId ${job.id}).`,
      `${job.watch ? "Checks" : "Schedule"}: ${describeSchedule(job.schedule)}.`,
      job.enabled
        ? job.nextRunAt !== undefined
          ? `Next ${job.watch ? "check" : "run"}: ${formatInstant(job.nextRunAt, timeZoneOf(job.schedule, options.defaultTimeZone))}.`
          : "Next run: not scheduled."
        : "It is paused.",
      job.watch
        ? "The first check only remembers the page. After that, a change that matters goes to the owner's Inbox (up to the daily limit); others wait for the next briefing."
        : job.briefing
          ? "Each briefing is a new chat in its project and arrives in the owner's Inbox."
          : "Each run is a new chat in its project; the owner sees results in the Inbox.",
    ].join("\n"),
    displayContent: { jobId: job.id, action: verb.toLowerCase() },
  });

  /** `schedule_briefing` input as job fields (a change merges the spec). */
  const briefingInput = (
    input: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> => {
    const {
      jobId,
      time,
      days,
      timeZone,
      sections,
      topics,
      maxWords,
      notes,
      ...rest
    } = input;
    const current = jobId !== undefined ? requireJob(jobId) : undefined;
    if (current && !current.briefing) {
      throw new JobInputError("not_a_briefing");
    }
    const body: Record<string, unknown> = { ...rest };
    if (jobId !== undefined) body.jobId = jobId;
    if (notes !== undefined) body.prompt = notes;
    if (
      !current ||
      time !== undefined ||
      days !== undefined ||
      timeZone !== undefined
    ) {
      const previous = current?.schedule;
      const previousTime =
        previous && previous.kind !== "interval" ? previous.time : undefined;
      const previousZone =
        previous && previous.kind !== "interval"
          ? previous.timeZone
          : undefined;
      const previousDays =
        previous?.kind === "weekly" ? previous.days : undefined;
      const nextDays = days ?? previousDays;
      body.schedule = {
        kind: nextDays ? "weekly" : "daily",
        time: time ?? previousTime ?? DEFAULT_BRIEFING_TIME,
        ...(nextDays ? { days: nextDays } : {}),
        ...((timeZone ?? previousZone)
          ? { timeZone: timeZone ?? previousZone }
          : {}),
      };
    }
    if (
      !current ||
      sections !== undefined ||
      topics !== undefined ||
      maxWords !== undefined
    ) {
      const previous: Partial<BriefingSpec> = current?.briefing ?? {};
      body.briefing = {
        sections: sections ?? previous.sections ?? [...BRIEFING_SECTIONS],
        topics: topics ?? previous.topics ?? [],
        maxWords: maxWords ?? previous.maxWords ?? DEFAULT_BRIEFING_WORDS,
      };
    }
    if (!current) {
      body.name ??= DEFAULT_BRIEFING_NAME;
      body.prompt ??= DEFAULT_BRIEFING_NOTES;
      // A briefing only reads; anything more asks the owner.
      body.approvalMode = "ask";
    }
    return body;
  };

  /** `watch_page` input as job fields (a change merges the watch target). */
  const watchInput = (
    input: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> => {
    const {
      jobId,
      url,
      selector,
      whatMatters,
      everyMinutes,
      notifyPerDay,
      ...rest
    } = input;
    const current = jobId !== undefined ? requireJob(jobId) : undefined;
    if (current && !current.watch) throw new JobInputError("not_a_watch");
    const body: Record<string, unknown> = { ...rest };
    if (jobId !== undefined) body.jobId = jobId;
    if (whatMatters !== undefined) body.prompt = whatMatters;
    if (everyMinutes !== undefined) {
      body.schedule = { kind: "interval", everyMinutes };
    }
    if (
      !current ||
      url !== undefined ||
      selector !== undefined ||
      notifyPerDay !== undefined
    ) {
      const previous: Partial<WatchTarget> = current?.watch ?? {};
      const nextSelector =
        selector !== undefined ? selector : previous.selector;
      body.watch = {
        url: url ?? previous.url,
        ...(nextSelector ? { selector: nextSelector } : {}),
        notifyPerDay:
          notifyPerDay ?? previous.notifyPerDay ?? DEFAULT_WATCH_NOTIFY_PER_DAY,
      };
    }
    if (!current) {
      body.schedule ??= {
        kind: "interval",
        everyMinutes: DEFAULT_WATCH_INTERVAL_MINUTES,
      };
      // The judging turn only reads; anything more asks the owner.
      body.approvalMode = "ask";
    }
    return body;
  };

  const listJobs = defineTool({
    name: "list_jobs",
    description:
      "List the owner's scheduled jobs: id, name, project, schedule, whether it is on, next run, and the last run's outcome.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    // Shown on the chat's tool card (inputs come from the model, no secrets).
    displayInput: (input) => input,
    effect: "read",
    parallelSafe: true,
    presentation: { title: "List scheduled jobs" },
    handler: async () => {
      const jobs = store.list();
      if (jobs.length === 0) {
        return { modelContent: "There are no scheduled jobs." };
      }
      return {
        modelContent: jobs
          .map((job) => {
            const last = store.runs(job.id)[0];
            const zone = timeZoneOf(job.schedule, options.defaultTimeZone);
            return [
              `- ${job.name} (jobId ${job.id})${job.watch ? " [watch]" : job.briefing ? " [briefing]" : ""}`,
              ...(job.briefing
                ? [
                    `  Briefing: ${describeBriefingSections(job.briefing.sections)}; topics: ${job.briefing.topics.join(", ") || "none"}; about ${job.briefing.maxWords} words`,
                  ]
                : []),
              ...(job.watch
                ? [
                    `  Watches: ${job.watch.url}${job.watch.selector ? ` (${job.watch.selector})` : ""}; tells you ${describeNotifyCap(job.watch.notifyPerDay)}`,
                  ]
                : []),
              `  Project: ${projectName(job.projectId)}`,
              `  Schedule: ${describeSchedule(job.schedule)}${job.enabled ? "" : " (paused)"}`,
              ...(job.enabled && job.nextRunAt !== undefined
                ? [`  Next run: ${formatInstant(job.nextRunAt, zone)}`]
                : []),
              ...(last
                ? [
                    `  Last run: ${last.status}${last.finishedAt ? `, ${formatInstant(last.finishedAt, zone)}` : ""}`,
                  ]
                : []),
              `  Approvals: ${job.approvalMode}; model: ${job.model ?? "project default"}`,
              `  ${job.watch ? "What matters" : job.briefing ? "Notes" : "Prompt"}: ${oneLine(job.prompt, 300)}`,
            ].join("\n");
          })
          .join("\n"),
        displayContent: { jobs: jobs.length },
      };
    },
  });

  const scheduleSchema = {
    type: "object",
    additionalProperties: false,
    description: `When it runs. Interval: {"kind":"interval","everyMinutes":N} (${MIN_INTERVAL_MINUTES} to ${MAX_INTERVAL_MINUTES}). Daily: {"kind":"daily","time":"HH:MM","timeZone"?}. Weekly: {"kind":"weekly","days":["mon","fri"],"time":"HH:MM","timeZone"?}. timeZone is an IANA name; without one the server's (${options.defaultTimeZone}) is used, so name the owner's when you know it.`,
    properties: {
      kind: { type: "string", enum: ["interval", "daily", "weekly"] },
      everyMinutes: {
        type: "integer",
        minimum: MIN_INTERVAL_MINUTES,
        maximum: MAX_INTERVAL_MINUTES,
      },
      time: { type: "string", description: '24-hour "HH:MM"' },
      days: {
        type: "array",
        minItems: 1,
        items: { type: "string", enum: [...WEEKDAYS] },
      },
      timeZone: { type: "string" },
    },
    required: ["kind"],
  };

  const scheduleJob = defineTool({
    name: "schedule_job",
    description: `Create a scheduled job, or change one by passing its jobId (from list_jobs) with only the fields to change. Each run sends the prompt to a new chat in the job's project, with no one watching, and the result lands in the owner's Inbox. Write the prompt as a complete, self-contained instruction for that future chat. The owner always approves the exact job before it is saved, so propose it directly rather than asking first. Runs use the job's approval mode: "autonomous" (default) lets runs edit files and run commands without asking; "ask" pauses a run for the owner on each such action.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        jobId: {
          type: "string",
          description: "Change this job; omit to create a new one",
        },
        name: {
          type: "string",
          minLength: 1,
          maxLength: MAX_JOB_NAME_LENGTH,
          description: "Short name shown in the Jobs list and the Inbox",
        },
        prompt: {
          type: "string",
          minLength: 1,
          maxLength: MAX_TOOL_PROMPT_LENGTH,
          description: "The message each run sends to its new chat",
        },
        schedule: scheduleSchema,
        projectId: {
          type: "string",
          description: `Project the runs work in (default: this chat's, ${options.projectId})`,
        },
        enabled: {
          type: "boolean",
          description: "false pauses the job (default true for a new job)",
        },
        approvalMode: { type: "string", enum: [...SESSION_APPROVAL_MODES] },
        model: {
          type: "string",
          description:
            '"providerId/modelId"; omit for the project\'s default model',
        },
        reasoningEffort: {
          type: "string",
          description: "Reasoning effort for that model; omit for its default",
        },
      },
    },
    // Shown on the chat's tool card (inputs come from the model, no secrets).
    displayInput: (input) => input,
    effect: "write",
    authorization: "required",
    presentation: { title: "Schedule a job" },
    handler: async (input) => applyPrepared(input),
  });

  const watchPage = defineTool({
    name: "watch_page",
    description: `Watch a web page or RSS/Atom feed for the owner ("watch this page", "tell me when X ships or changes"), or change a watch by passing its jobId (from list_jobs) with only the fields to change. The server checks it on a schedule without a model, using conditional requests, and only when the watched text changed does a short model turn judge the change against whatMatters. Relevant changes go to the owner's Inbox, at most notifyPerDay a day; the rest wait for the next briefing. Prefer this to a scheduled job that reads a page each time. Pick the most specific public URL (a feed, a release page, a raw file) and a selector when only part of a page matters. The owner approves the exact watch first, so propose it directly.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        jobId: {
          type: "string",
          description: "Change this watch; omit to create a new one",
        },
        name: {
          type: "string",
          minLength: 1,
          maxLength: MAX_JOB_NAME_LENGTH,
          description: "Short name shown in the Jobs list and the Inbox",
        },
        url: {
          type: "string",
          minLength: 1,
          maxLength: 2_048,
          description: "The public https page or RSS/Atom feed to watch",
        },
        selector: {
          type: "string",
          maxLength: 200,
          description:
            'One simple CSS selector for the part that matters (a tag, "#id", ".class", or a mix like "div.release"); omit for the main text; "" clears it',
        },
        whatMatters: {
          type: "string",
          minLength: 1,
          maxLength: MAX_TOOL_PROMPT_LENGTH,
          description:
            "In the owner's terms, which changes are worth telling them about (and which are not)",
        },
        everyMinutes: {
          type: "integer",
          minimum: MIN_INTERVAL_MINUTES,
          maximum: MAX_INTERVAL_MINUTES,
          description: `How often to check, in minutes (default ${DEFAULT_WATCH_INTERVAL_MINUTES})`,
        },
        notifyPerDay: {
          type: "integer",
          minimum: 0,
          maximum: MAX_WATCH_NOTIFY_PER_DAY,
          description: `Most notifications a day (default ${DEFAULT_WATCH_NOTIFY_PER_DAY}); 0 sends everything to the briefing`,
        },
        projectId: {
          type: "string",
          description: `Project its judging chats go in (default: this chat's, ${options.projectId})`,
        },
        enabled: {
          type: "boolean",
          description: "false pauses the watch (default true for a new one)",
        },
      },
    },
    // Shown on the chat's tool card (inputs come from the model, no secrets).
    displayInput: (input) => input,
    effect: "write",
    authorization: "required",
    presentation: { title: "Watch a page" },
    handler: async (input) => applyPrepared(input),
  });

  const scheduleBriefing = defineTool({
    name: "schedule_briefing",
    description: `Schedule a regular briefing for the owner ("brief me every morning", "a daily roundup of games and tech news"), or change one by passing its jobId (from list_jobs) with only the fields to change. Each briefing is a short chat at the set time that pulls together the sections asked for: changes the owner's watches found since the last briefing, news on the topics (with web search), calendar and email (once connected), and things waiting for the owner in the Assistant. Every item carries a source link, and it lands in the Inbox. Defaults: every day at ${DEFAULT_BRIEFING_TIME} in the owner's time zone, every section, about ${DEFAULT_BRIEFING_WORDS} words. The owner approves the exact briefing first, so propose it directly.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        jobId: {
          type: "string",
          description: "Change this briefing; omit to create a new one",
        },
        name: {
          type: "string",
          minLength: 1,
          maxLength: MAX_JOB_NAME_LENGTH,
          description: `Short name (default "${DEFAULT_BRIEFING_NAME}")`,
        },
        time: {
          type: "string",
          description: `24-hour "HH:MM" it arrives (default ${DEFAULT_BRIEFING_TIME})`,
        },
        days: {
          type: "array",
          minItems: 1,
          items: { type: "string", enum: [...WEEKDAYS] },
          description: "Only on these days; omit for every day",
        },
        timeZone: {
          type: "string",
          description: `IANA time zone; omit for the owner's (${options.defaultTimeZone})`,
        },
        sections: {
          type: "array",
          minItems: 1,
          items: { type: "string", enum: [...BRIEFING_SECTIONS] },
          description: "Sections in order (default all)",
        },
        topics: {
          type: "array",
          maxItems: MAX_BRIEFING_TOPICS,
          items: { type: "string", minLength: 1, maxLength: 80 },
          description: "News topics, in the owner's words",
        },
        maxWords: {
          type: "integer",
          minimum: MIN_BRIEFING_WORDS,
          maximum: MAX_BRIEFING_WORDS,
          description: `Length budget (default ${DEFAULT_BRIEFING_WORDS})`,
        },
        notes: {
          type: "string",
          minLength: 1,
          maxLength: MAX_TOOL_PROMPT_LENGTH,
          description:
            "Anything else the owner wants in it or left out, in their words",
        },
        projectId: {
          type: "string",
          description: `Project its chats go in (default: this chat's, ${options.projectId}); news needs one on the Open web preset`,
        },
        enabled: {
          type: "boolean",
          description: "false pauses the briefing (default true for a new one)",
        },
      },
    },
    // Shown on the chat's tool card (inputs come from the model, no secrets).
    displayInput: (input) => input,
    effect: "write",
    authorization: "required",
    presentation: { title: "Schedule a briefing" },
    handler: async (input) => applyPrepared(input),
  });

  const deleteJob = defineTool({
    name: "delete_job",
    description:
      "Delete a scheduled job or watch (from list_jobs) and its run history; its run chats stay, and a watch's snapshots are deleted. The owner approves it first. To stop one for a while instead, change it with enabled false.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { jobId: { type: "string", minLength: 1 } },
      required: ["jobId"],
    },
    // Shown on the chat's tool card (inputs come from the model, no secrets).
    displayInput: (input) => input,
    effect: "write",
    authorization: "required",
    presentation: { title: "Delete a scheduled job" },
    handler: async (input) => applyPrepared(input),
  });

  /** Only a change prepared here and approved by the owner is applied. */
  const applyPrepared = async (
    input: Record<string, unknown>,
  ): Promise<HostToolResult> => {
    const change = input[PREPARED_KEY];
    if (!isPreparedChange(change)) {
      return failure("This change was not approved by the owner");
    }
    return await apply(change);
  };

  const approvalTools: HostTool[] = [
    scheduleJob,
    watchPage,
    scheduleBriefing,
    deleteJob,
  ];
  return {
    readTools: () => [listJobs],
    approvalTools: {
      toolNames: JOB_TOOL_NAMES,
      resolveTools: () => approvalTools,
      prepare: (request) => prepare(request.toolName, request.input),
      validatePending: ({ input }) => {
        const change = input[PREPARED_KEY];
        if (!isPreparedChange(change)) {
          return { ok: false, reason: "The job change is not available" };
        }
        const stale = stillApplies(change);
        return stale ? { ok: false, reason: stale } : { ok: true };
      },
    },
  };
}

/** Model input never has this key: the schemas refuse unknown fields. */
const PREPARED_KEY = "preparedJobChange";

function preparedInput(change: PreparedChange): Record<string, unknown> {
  return { [PREPARED_KEY]: change };
}

function isPreparedChange(value: unknown): value is PreparedChange {
  if (!value || typeof value !== "object") return false;
  const change = value as Record<string, unknown>;
  switch (change.action) {
    case "create":
      return !!change.fields && typeof change.fields === "object";
    case "update":
      return (
        typeof change.jobId === "string" &&
        typeof change.expectedUpdatedAt === "number" &&
        !!change.patch &&
        typeof change.patch === "object"
      );
    case "delete":
      return (
        typeof change.jobId === "string" &&
        typeof change.expectedUpdatedAt === "number"
      );
    default:
      return false;
  }
}

const DAY_NAMES: Record<(typeof WEEKDAYS)[number], string> = {
  sun: "Sun",
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
};

/** A schedule in plain words, for approval cards and tool results. */
export function describeSchedule(schedule: JobSchedule): string {
  if (schedule.kind === "interval") {
    const minutes = schedule.everyMinutes;
    if (minutes % 1_440 === 0) {
      return minutes === 1_440 ? "every day" : `every ${minutes / 1_440} days`;
    }
    if (minutes % 60 === 0) {
      return minutes === 60 ? "every hour" : `every ${minutes / 60} hours`;
    }
    return `every ${minutes} minutes`;
  }
  const at = `at ${schedule.time} (${schedule.timeZone})`;
  if (schedule.kind === "daily") return `every day ${at}`;
  const days = schedule.days.join(",");
  if (days === "mon,tue,wed,thu,fri") return `every weekday ${at}`;
  if (days === "sun,sat") return `every weekend ${at}`;
  if (schedule.days.length === 7) return `every day ${at}`;
  return `every ${schedule.days.map((day) => DAY_NAMES[day]).join(", ")} ${at}`;
}

function describeNotifyCap(perDay: number): string {
  if (perDay === 0) return "never directly; every change goes to the briefing";
  return `at most ${perDay === 1 ? "once" : `${perDay} times`} a day; further changes go to the next briefing`;
}

function describeApprovalMode(mode: string): string {
  return mode === "ask"
    ? "ask (a run pauses for you before editing files or running commands)"
    : "autonomous (runs edit files and run commands without asking; protected files and background actions still ask)";
}

function firstRun(schedule: JobSchedule, at: number): number {
  return nextOccurrence(schedule, at, at);
}

function timeZoneOf(schedule: JobSchedule, fallback: string): string {
  return schedule.kind === "interval" ? fallback : schedule.timeZone;
}

export function formatInstant(instant: number, timeZone: string): string {
  return `${new Intl.DateTimeFormat("en-AU", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(instant)} (${timeZone})`;
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function failure(message: string): HostToolResult {
  return { modelContent: message, isError: true };
}
