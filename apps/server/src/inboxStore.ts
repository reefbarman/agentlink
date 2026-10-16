import type { JobDefinition, JobRun } from "./jobStore.js";
import type { SessionAlert } from "./sessionWatch.js";
import { evidenceFor, type TaskRun } from "./taskStore.js";

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { writeFileAtomic } from "./atomicFile.js";

/**
 * The owner's inbox: things the Assistant did or needs while nobody was
 * watching (finished, failed or blocked job runs and coding tasks, and runs
 * or tasks waiting for an approval). Kept in `<dataRoot>/inbox/inbox.json`,
 * replaced atomically.
 * The inbox is the record of these events; notifications are best effort.
 */

/** Entries kept; the oldest read ones go first. */
export const MAX_INBOX_ENTRIES = 500;
const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 500;

export type InboxEntryKind =
  | "run_completed"
  | "run_failed"
  | "run_blocked"
  | "needs_approval"
  /** A task's draft pull request was opened or updated. */
  | "task_published"
  /** A task is ready with its evidence but was not published. */
  | "task_ready"
  | "task_blocked"
  | "task_failed"
  /** A chat or task has been working a long time (the runaway guard). */
  | "session_long_running"
  /** A chat or task looks stuck: repeating itself, or gone quiet. */
  | "session_stuck"
  /** A backup failed, or none has succeeded for over a day. */
  | "backup_failed"
  /** The server started from a restored backup. */
  | "restored"
  /** A chat's turn was stopped (for an upgrade); asking again continues. */
  | "chat_interrupted"
  /** Audit checkpoints are not reaching the witness, or the log no longer matches them. */
  | "audit_checkpoint"
  /** An MCP server's tools changed, so they ask again. */
  | "mcp_changed"
  /** A watch found a change that matters. */
  | "watch_changed"
  /** A job's run used far more than usual, or watches told you a lot today. */
  | "job_noisy";

export interface InboxEntry {
  readonly id: string;
  readonly kind: InboxEntryKind;
  readonly createdAt: number;
  readonly title: string;
  /** A short summary or reason. */
  readonly body?: string;
  readonly projectId: string;
  /** The chat it is about, if any. */
  readonly sessionId?: string;
  readonly jobId?: string;
  readonly runId?: string;
  /** The coding task it is about. */
  readonly taskId?: string;
  readonly read: boolean;
}

export type NewInboxEntry = Omit<InboxEntry, "id" | "createdAt" | "read">;

export interface InboxStore {
  /** Newest first. */
  list(): readonly InboxEntry[];
  unreadCount(): number;
  /**
   * Add an entry, unless an unread one of the same kind for the same run
   * or task is already there. Resolves to the entry added, if any.
   */
  add(entry: NewInboxEntry, now: number): Promise<InboxEntry | undefined>;
  /** Mark entries read: these IDs, or every entry. Resolves to how many. */
  markRead(ids: readonly string[] | "all"): Promise<number>;
  /** Mark a run's unread entries of one kind read (it moved on). */
  markRunRead(runId: string, kind: InboxEntryKind): Promise<number>;
  /** Mark a task's unread entries read (it is working again). */
  markTaskRead(taskId: string): Promise<number>;
  /**
   * Delete the entries about a deleted chat or task, read or not, from the
   * file. Resolves to how many.
   */
  remove(about: {
    readonly projectId?: string;
    readonly sessionId?: string;
    readonly taskId?: string;
  }): Promise<number>;
  flush(): Promise<void>;
}

interface StoredInbox {
  readonly schemaVersion: 1;
  readonly entries: readonly InboxEntry[];
}

/**
 * The inbox entry a run's new record calls for, if any. Runs that are
 * queued, running, skipped or cancelled by the owner raise none.
 */
export function inboxEntryForRun(
  run: JobRun,
  job: Pick<JobDefinition, "name"> & Partial<Pick<JobDefinition, "watch">>,
  /** The job's run before this one, for a watch that keeps failing. */
  previous?: JobRun,
): NewInboxEntry | undefined {
  const base = {
    projectId: run.projectId,
    jobId: run.jobId,
    runId: run.runId,
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
  };
  const body = (text: string | undefined) =>
    text ? { body: truncate(text, MAX_BODY_LENGTH) } : {};
  if (job.watch) {
    // A watch tells you about relevant changes only, and about a page it
    // cannot read once, not every check.
    if (run.status === "completed") {
      return run.watch?.notified
        ? {
            ...base,
            kind: "watch_changed",
            title: `${job.name}: changed`,
            ...body(run.summary),
          }
        : undefined;
    }
    if (
      run.status === "failed" &&
      run.watch?.outcome === "fetch_failed" &&
      previous?.watch?.outcome === "fetch_failed" &&
      previous.error === run.error
    ) {
      return undefined;
    }
  }
  switch (run.status) {
    case "completed":
      return {
        ...base,
        kind: "run_completed",
        title: `${job.name} finished`,
        ...body(run.summary),
      };
    case "awaiting_approval":
      return {
        ...base,
        kind: "needs_approval",
        title: `${job.name} needs your approval`,
        body: "The run is paused until you allow or deny its request.",
      };
    case "blocked_auth":
      return {
        ...base,
        kind: "run_blocked",
        title: `${job.name} could not run`,
        body: withDetail(
          "The model provider's sign-in is missing or has expired.",
          run.errorDetail,
        ),
      };
    case "blocked_quota":
      return {
        ...base,
        kind: "run_blocked",
        title: `${job.name} could not run`,
        body: withDetail(
          "The model provider refused the run (usage or rate limits).",
          run.errorDetail,
        ),
      };
    case "failed":
      return {
        ...base,
        kind: "run_failed",
        title: `${job.name} failed`,
        // What went wrong when known; the bare error code otherwise.
        ...body(run.errorDetail ?? run.error),
      };
    case "interrupted":
      return {
        ...base,
        kind: "run_failed",
        title: `${job.name} was interrupted`,
        body: "The server restarted during the run. Its chat keeps what it did.",
      };
    case "cancelled":
      // The owner stopping a run needs no reminder; an approval nobody
      // answered does.
      return run.error === "approval_expired"
        ? {
            ...base,
            kind: "run_failed",
            title: `${job.name} was cancelled`,
            body: "Nobody answered its approval in time.",
          }
        : undefined;
    default:
      return undefined;
  }
}

/**
 * The inbox entry a task's record calls for, if any: published, ready but
 * not published, blocked, failed, or waiting for an approval. Working,
 * queued and owner-cancelled tasks raise none.
 */
export function inboxEntryForTask(task: TaskRun): NewInboxEntry | undefined {
  const name = taskName(task.objective);
  const base = {
    projectId: task.projectId,
    taskId: task.id,
    ...(task.sessionId ? { sessionId: task.sessionId } : {}),
  };
  const evidence = taskEvidenceLine(task);
  switch (task.state) {
    case "published":
      return {
        ...base,
        kind: "task_published",
        title: `Draft PR ready: ${name}`,
        body: joinLines(
          task.pullRequest
            ? `#${task.pullRequest.number} ${task.pullRequest.url}`
            : undefined,
          evidence,
        ),
      };
    case "ready":
      return {
        ...base,
        kind: "task_ready",
        title: `Task ready: ${name}`,
        body: joinLines(notPublishedReason(task), evidence),
      };
    case "awaiting_approval":
      return {
        ...base,
        kind: "needs_approval",
        title: `Task needs your approval: ${name}`,
        body: "The task is paused until you allow or deny its request.",
      };
    case "blocked_review":
      return {
        ...base,
        kind: "task_blocked",
        title: `Task not reviewed: ${name}`,
        body: joinLines(
          "No reviewer on another provider could review it. Resume it once one is available, or publish it without a review.",
          task.errorDetail,
        ),
      };
    case "blocked_auth":
      return {
        ...base,
        kind: "task_blocked",
        title: `Task blocked: ${name}`,
        body: withDetail(
          "The model provider's sign-in is missing or has expired.",
          task.errorDetail,
        ),
      };
    case "blocked_quota":
      return {
        ...base,
        kind: "task_blocked",
        title: `Task blocked: ${name}`,
        body: withDetail(
          "The model provider refused it (usage or rate limits).",
          task.errorDetail,
        ),
      };
    case "failed":
      return {
        ...base,
        kind: "task_failed",
        title: `Task failed: ${name}`,
        body: joinLines(task.errorDetail ?? task.error, evidence),
      };
    case "interrupted":
      return {
        ...base,
        kind: "task_failed",
        title: `Task interrupted: ${name}`,
        body: "The server restarted while it worked. Resume it to continue in the same chat and clone.",
      };
    case "cancelled":
      return task.error === "approval_expired"
        ? {
            ...base,
            kind: "task_failed",
            title: `Task cancelled: ${name}`,
            body: "Nobody answered its approval in time.",
          }
        : undefined;
    default:
      return undefined;
  }
}

/**
 * The inbox entry for a runaway-guard alert. Only a notice: the work goes
 * on until the owner stops it. `name` is the chat's or task's name.
 */
export function inboxEntryForSessionAlert(
  alert: SessionAlert,
  name: string | undefined,
): NewInboxEntry {
  const label = name ? `"${truncate(name, 80)}"` : "A chat";
  const base = {
    projectId: alert.projectId,
    sessionId: alert.sessionId,
  };
  const hours = Math.max(1, Math.floor(alert.elapsedMs / 3_600_000));
  const running = `It has been working for ${hours === 1 ? "an hour" : `${hours} hours`}.`;
  switch (alert.kind) {
    case "long_running":
      return {
        ...base,
        kind: "session_long_running",
        title: `${label} is still working`,
        body: `${running} It keeps going until it finishes or you stop it.`,
      };
    case "repeating":
      return {
        ...base,
        kind: "session_stuck",
        title: `${label} may be stuck`,
        body: `It has run ${alert.toolName ?? "the same tool"} with the same input ${alert.repeats ?? "many"} times in a row. Stop it, or let it keep going.`,
      };
    case "quiet":
      return {
        ...base,
        kind: "session_stuck",
        title: `${label} may be stuck`,
        body: "It has shown no new output or results for a while. Stop it, or let it keep going.",
      };
  }
}

/** The objective's first line, short enough for a title. */
function taskName(objective: string): string {
  const line =
    objective
      .split("\n")
      .map((entry) => entry.trim())
      .find(Boolean) ?? "Coding task";
  return truncate(line, 80);
}

/** Commit, validation and review for the task's head commit. */
function taskEvidenceLine(task: TaskRun): string | undefined {
  const head = task.headCommit;
  if (!head) return undefined;
  const { validation, review } = evidenceFor(task, head);
  const parts = [`Commit ${head.slice(0, 7)}`];
  if (validation) {
    const passed = validation.commands.filter(
      (command) => command.exitCode === 0 && !command.timedOut,
    ).length;
    parts.push(
      validation.passed
        ? `validation passed (${passed}/${validation.commands.length})`
        : `validation failed (${passed}/${validation.commands.length} passed)`,
    );
  }
  if (review) {
    const blocking = review.findings.filter(
      (finding) => finding.severity === "blocking",
    ).length;
    parts.push(
      review.verdict === "approve"
        ? `approved by ${review.model}`
        : `${blocking} open finding${blocking === 1 ? "" : "s"} from ${review.model}`,
    );
  } else if (task.state !== "failed") {
    parts.push("not reviewed");
  }
  return `${parts.join(", ")}.`;
}

/** Why a ready task is waiting for the owner instead of published. */
function notPublishedReason(task: TaskRun): string {
  if (task.error) {
    return withDetail(`Publishing failed (${task.error}).`, task.errorDetail);
  }
  if (task.openFindings) {
    return "The review still has blocking findings: publish it yourself if they can wait.";
  }
  return "Not published: give the repository a GitHub connection to publish it, or publish it from Tasks.";
}

function joinLines(...lines: (string | undefined)[]): string | undefined {
  const text = lines.filter(Boolean).join("\n");
  return text || undefined;
}

export async function openInboxStore(options: {
  readonly directory: string;
  /** Entries kept (tests); `MAX_INBOX_ENTRIES` by default. */
  readonly maxEntries?: number;
}): Promise<InboxStore> {
  const maxEntries = options.maxEntries ?? MAX_INBOX_ENTRIES;
  const file = path.join(options.directory, "inbox.json");
  /** Oldest first. */
  let entries: InboxEntry[] = await readEntries(file);

  let writes: Promise<void> = Promise.resolve();
  const persist = () => {
    const content: StoredInbox = { schemaVersion: 1, entries };
    const next = writes.then(async () => {
      await fs.mkdir(options.directory, { recursive: true, mode: 0o700 });
      await writeFileAtomic(file, `${JSON.stringify(content)}\n`);
    });
    writes = next.catch(() => undefined);
    return next;
  };

  const prune = () => {
    while (entries.length > maxEntries) {
      const drop = entries.findIndex((entry) => entry.read);
      entries.splice(drop < 0 ? 0 : drop, 1);
    }
  };

  const markWhere = async (matches: (entry: InboxEntry) => boolean) => {
    let changed = 0;
    entries = entries.map((entry) => {
      if (entry.read || !matches(entry)) return entry;
      changed += 1;
      return { ...entry, read: true };
    });
    if (changed > 0) await persist();
    return changed;
  };

  return {
    list: () => [...entries].reverse(),
    unreadCount: () => entries.filter((entry) => !entry.read).length,
    async add(input, now) {
      if (
        (input.runId || input.taskId) &&
        entries.some(
          (entry) =>
            !entry.read &&
            entry.kind === input.kind &&
            (input.runId
              ? entry.runId === input.runId
              : entry.taskId === input.taskId),
        )
      ) {
        return undefined;
      }
      // One unread runaway notice per chat and kind.
      if (
        isSessionAlertKind(input.kind) &&
        entries.some(
          (entry) =>
            !entry.read &&
            entry.kind === input.kind &&
            entry.projectId === input.projectId &&
            entry.sessionId === input.sessionId,
        )
      ) {
        return undefined;
      }
      const entry: InboxEntry = {
        ...input,
        title: truncate(input.title, MAX_TITLE_LENGTH),
        ...(input.body ? { body: truncate(input.body, MAX_BODY_LENGTH) } : {}),
        id: randomUUID(),
        createdAt: now,
        read: false,
      };
      entries.push(entry);
      prune();
      await persist();
      return entry;
    },
    markRead(ids) {
      if (ids === "all") return markWhere(() => true);
      const wanted = new Set(ids);
      return markWhere((entry) => wanted.has(entry.id));
    },
    markRunRead(runId, kind) {
      return markWhere((entry) => entry.runId === runId && entry.kind === kind);
    },
    markTaskRead(taskId) {
      return markWhere((entry) => entry.taskId === taskId);
    },
    async remove(about) {
      const matches = (entry: InboxEntry) =>
        (about.taskId !== undefined && entry.taskId === about.taskId) ||
        (about.sessionId !== undefined &&
          entry.sessionId === about.sessionId &&
          (about.projectId === undefined ||
            entry.projectId === about.projectId));
      const before = entries.length;
      entries = entries.filter((entry) => !matches(entry));
      const removed = before - entries.length;
      if (removed > 0) await persist();
      return removed;
    },
    async flush() {
      await writes;
    },
  };
}

/** An unreadable inbox starts empty: it holds reminders, not work. */
async function readEntries(file: string): Promise<InboxEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredInbox>;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries)) {
      return [];
    }
    return parsed.entries.filter(isEntry);
  } catch {
    return [];
  }
}

/** The inbox entry for a failed or overdue backup. */
export function inboxEntryForBackupProblem(
  problem:
    | { readonly kind: "failed"; readonly error: string }
    | { readonly kind: "overdue"; readonly lastSuccessAt?: number },
  projectId: string,
  timeZone?: string,
): NewInboxEntry {
  if (problem.kind === "failed") {
    return {
      projectId,
      kind: "backup_failed",
      title: "A backup failed",
      body: withDetail(
        "The last backup did not finish. Nothing else is affected; it tries again within the hour.",
        problem.error,
      ),
    };
  }
  return {
    projectId,
    kind: "backup_failed",
    title: "No backup for over a day",
    body: problem.lastSuccessAt
      ? `The last good backup was ${new Date(problem.lastSuccessAt).toLocaleString("en-AU", timeZone ? { timeZone } : {})}. Check that the backup service and its store are running.`
      : "No backup has finished yet. Check that the backup service and its store are running.",
  };
}

/** The inbox entry for a start from a restored backup. */
export function inboxEntryForRestore(
  restored: {
    readonly snapshotId: string;
    readonly snapshotTime: string;
    readonly reason?: string;
  },
  pausedJobs: readonly string[],
  projectId: string,
): NewInboxEntry {
  const taken = Date.parse(restored.snapshotTime);
  const backup = `backup ${restored.snapshotId.slice(0, 8)}${Number.isFinite(taken) ? `, taken ${new Date(taken).toISOString().replace("T", " ").slice(0, 16)} UTC` : ""}`;
  if (restored.reason === "upgrade-rollback") {
    return {
      projectId,
      kind: "restored",
      title: "An upgrade failed and was rolled back",
      body: joinLines(
        `An upgrade did not pass its checks, so the Assistant went back to the version before it, with its records from ${backup} (taken just before the upgrade). Work that was stopped for the upgrade is interrupted; resume it from Tasks.`,
        pausedJobs.length > 0
          ? `Paused scheduled jobs until you turn them back on in Jobs: ${pausedJobs.join(", ")}.`
          : undefined,
      ),
    };
  }
  return {
    projectId,
    kind: "restored",
    title: "Restored from a backup",
    body: joinLines(
      `The Assistant was restored from ${backup}. Anything after that is not here, and work that was running then is interrupted (resume it from Tasks).`,
      pausedJobs.length > 0
        ? `Paused scheduled jobs until you turn them back on in Jobs: ${pausedJobs.join(", ")}.`
        : undefined,
    ),
  };
}

/** The inbox entry for a chat turn stopped by a drain at its deadline. */
export function inboxEntryForInterruptedChat(chat: {
  readonly projectId: string;
  readonly sessionId: string;
}): NewInboxEntry {
  return {
    projectId: chat.projectId,
    sessionId: chat.sessionId,
    kind: "chat_interrupted",
    title: "A chat was stopped for an upgrade",
    body: "It was still working when the Assistant was upgraded. Open the chat and ask it to carry on.",
  };
}

/** The inbox entry for a checkpoint that failed, or a log that no longer matches. */
export function inboxEntryForCheckpointProblem(
  problem:
    | { readonly kind: "failed"; readonly error: string }
    | { readonly kind: "mismatch"; readonly problems: readonly string[] },
  projectId: string,
): NewInboxEntry {
  if (problem.kind === "failed") {
    return {
      projectId,
      kind: "audit_checkpoint",
      title: "Audit checkpoints are not reaching the backup store",
      body: withDetail(
        "The audit log's latest entries are not checkpointed yet. It tries again every 10 minutes; check that the backup service and its store are running.",
        problem.error,
      ),
    };
  }
  return {
    projectId,
    kind: "audit_checkpoint",
    title: "The audit log does not match its checkpoints",
    body: truncate(
      `The task audit log was changed after it was checkpointed: ${problem.problems.join("; ")}. Run \`agentlink-server audit-check --checkpoints\` on the server for details.`,
      MAX_BODY_LENGTH,
    ),
  };
}

/** The inbox entry for MCP tools that changed and ask again. */
export function inboxEntryForMcpChange(
  server: { readonly label: string },
  changed: readonly string[],
  projectId: string,
): NewInboxEntry {
  return {
    projectId,
    kind: "mcp_changed",
    title: `Tools on "${truncate(server.label, 60)}" changed`,
    body: truncate(
      `${changed.join(", ")} changed on the server, so ${changed.length === 1 ? "it asks" : "they ask"} you before each call again, and any call waiting for approval was cancelled. Set ${changed.length === 1 ? "it" : "them"} back to Run in the MCP panel if the change looks right.`,
      MAX_BODY_LENGTH,
    ),
  };
}

/** Runaway-guard notices, which offer Stop and Keep going. */
/** A run that used far more of the model than the job usually does. */
export function inboxEntryForUnusualUsage(
  run: JobRun,
  job: Pick<JobDefinition, "name">,
  usualTokens: number,
): NewInboxEntry {
  const tokens = (run.usage?.inputTokens ?? 0) + (run.usage?.outputTokens ?? 0);
  return {
    kind: "job_noisy",
    projectId: run.projectId,
    jobId: run.jobId,
    runId: run.runId,
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    title: `${job.name} used more than usual`,
    body: `This run used ${tokens.toLocaleString("en-AU")} tokens in ${run.usage?.requests ?? 0} model requests, over three times its usual ${usualTokens.toLocaleString("en-AU")}. Nothing was stopped.`,
  };
}

/** Watches together told the owner more than the day's guard. */
export function inboxEntryForWatchNoise(
  count: number,
  projectId: string,
): NewInboxEntry {
  return {
    kind: "job_noisy",
    projectId,
    title: "Watches are busy today",
    body: `Your watches have told you about ${count} changes today. Each watch still stops at its own daily limit; change a watch's limit or what matters in a chat if this is too many.`,
  };
}

export function isSessionAlertKind(kind: InboxEntryKind): boolean {
  return kind === "session_long_running" || kind === "session_stuck";
}

function isEntry(value: unknown): value is InboxEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.kind === "string" &&
    typeof entry.createdAt === "number" &&
    typeof entry.title === "string" &&
    typeof entry.projectId === "string" &&
    typeof entry.read === "boolean"
  );
}

/** A fixed explanation, then what the provider actually said. */
function withDetail(text: string, detail: string | undefined): string {
  return detail ? `${text} ${detail}` : text;
}

function truncate(value: string, max: number): string {
  const text = value.replace(/\s+/gu, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
