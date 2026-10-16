import { Dialog, errorText, requestJson } from "./AssistantProjects";
import { BackupSettings } from "./AssistantBackups";
import { GitHubPanel } from "./AssistantGitHub";
import { McpPanel, signInReturnNotice } from "./AssistantMcp";
import { MemoryPanel } from "./AssistantMemory";
import { SettingsPanel } from "./AssistantSettings";
import { OPEN_TASK_EVENT, TasksPanel } from "./AssistantTasks";
import {
  NotificationSettings,
  useLocalInboxNotifications,
  useNotificationLinks,
  type OpenTarget,
} from "./AssistantNotifications";
import { useEffect, useState } from "preact/hooks";

/**
 * Scheduled jobs and the inbox for the AgentLink Assistant: sidebar entries
 * (the inbox with its unread count) that open a Jobs panel (list, create,
 * edit, run now, pause, history) and an Inbox panel (grouped by day, mark
 * read, open the chat). Both refetch when the snapshot's revision changes,
 * so open tabs follow runs and new entries without polling.
 */

export const WEEKDAYS = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
] as const;
export type Weekday = (typeof WEEKDAYS)[number];
const WEEKDAY_LABELS: Record<Weekday, string> = {
  sun: "Sun",
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
};

export type JobSchedule =
  | { kind: "interval"; everyMinutes: number }
  | { kind: "daily"; time: string; timeZone: string }
  | { kind: "weekly"; days: Weekday[]; time: string; timeZone: string };

export type JobRunStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "blocked_auth"
  | "blocked_quota"
  | "skipped";

export interface JobRun {
  runId: string;
  jobId: string;
  projectId: string;
  trigger: "schedule" | "catch_up" | "manual";
  status: JobRunStatus;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  sessionId?: string;
  title?: string;
  summary?: string;
  error?: string;
  /** What went wrong, in words, when the server knows. */
  errorDetail?: string;
  /** Model use, when the run called a model. */
  usage?: { requests: number; inputTokens: number; outputTokens: number };
  /** A watch run: what its check found. */
  watch?: {
    outcome:
      | "not_modified"
      | "unchanged"
      | "baseline"
      | "changed"
      | "fetch_failed";
    relevant?: boolean;
    notified?: boolean;
    heldForBriefing?: boolean;
  };
  /** A briefing run: what it covered and how well it was sourced. */
  briefing?: {
    since: number;
    through: number;
    watchChanges: number;
    unsourced?: number;
  };
}

/** A briefing job's shape; its prompt is the owner's notes. */
export interface JobBriefing {
  sections: Array<"watches" | "news" | "calendar" | "email" | "open_items">;
  topics: string[];
  maxWords: number;
}

/** A watch job's page; its prompt is the owner's "what matters" note. */
export interface JobWatch {
  url: string;
  selector?: string;
  notifyPerDay: number;
}

export interface Job {
  id: string;
  name: string;
  projectId: string;
  prompt: string;
  schedule: JobSchedule;
  enabled: boolean;
  model?: string;
  reasoningEffort?: string;
  approvalMode: "autonomous" | "ask";
  nextRunAt?: number;
  lastRun?: JobRun;
  activeRun?: JobRun;
  watch?: JobWatch;
  briefing?: JobBriefing;
  watchState?: {
    checkedAt?: number;
    snapshots: number;
    recentChanges: Array<{
      at: number;
      summary: string;
      notified: boolean;
      sessionId?: string;
    }>;
  };
}

export interface InboxEntry {
  id: string;
  kind:
    | "run_completed"
    | "run_failed"
    | "run_blocked"
    | "needs_approval"
    | "task_published"
    | "task_ready"
    | "task_blocked"
    | "task_failed"
    | "session_long_running"
    | "session_stuck"
    | "backup_failed"
    | "restored"
    | "chat_interrupted"
    | "audit_checkpoint"
    | "mcp_changed"
    | "watch_changed"
    | "briefing"
    | "job_noisy";
  createdAt: number;
  title: string;
  body?: string;
  projectId: string;
  sessionId?: string;
  jobId?: string;
  runId?: string;
  /** A coding task's entry opens the task, not its chat. */
  taskId?: string;
  read: boolean;
}

interface ProjectOption {
  id: string;
  label: string;
}

interface ModelOption {
  id: string;
  displayName?: string;
  providerDisplayName?: string;
  reasoningEfforts?: string[];
}

const RUN_STATUS: Record<
  JobRunStatus,
  { label: string; tone: "busy" | "ok" | "warn" | "bad" | "muted" }
> = {
  queued: { label: "Queued", tone: "busy" },
  running: { label: "Running", tone: "busy" },
  awaiting_approval: { label: "Needs your approval", tone: "warn" },
  completed: { label: "Finished", tone: "ok" },
  failed: { label: "Failed", tone: "bad" },
  cancelled: { label: "Cancelled", tone: "muted" },
  interrupted: { label: "Interrupted", tone: "bad" },
  blocked_auth: { label: "Blocked: sign-in", tone: "bad" },
  blocked_quota: { label: "Blocked: limits", tone: "bad" },
  skipped: { label: "Skipped", tone: "muted" },
};

export function runStatusLabel(status: JobRunStatus): string {
  return RUN_STATUS[status]?.label ?? status;
}

const INBOX_ICONS: Record<InboxEntry["kind"], string> = {
  run_completed: "pass",
  run_failed: "error",
  run_blocked: "warning",
  needs_approval: "shield",
  task_published: "git-pull-request",
  task_ready: "pass",
  task_blocked: "warning",
  task_failed: "error",
  session_long_running: "watch",
  session_stuck: "warning",
  backup_failed: "warning",
  restored: "history",
  chat_interrupted: "debug-pause",
  audit_checkpoint: "shield",
  mcp_changed: "plug",
  watch_changed: "eye",
  briefing: "megaphone",
  job_noisy: "pulse",
};

/** A watch run's outcome in words, for its history. */
export function watchOutcomeLabel(run: JobRun): string | undefined {
  const watch = run.watch;
  if (!watch) return undefined;
  switch (watch.outcome) {
    case "not_modified":
    case "unchanged":
      return "No change";
    case "baseline":
      return "First check";
    case "fetch_failed":
      return "Could not read the page";
    case "changed":
      if (watch.relevant === undefined) return "Changed";
      if (!watch.relevant) return "Changed, not relevant";
      return watch.notified
        ? "Changed, told you"
        : "Changed, kept for the briefing";
  }
}

const BRIEFING_SECTION_NAMES: Record<JobBriefing["sections"][number], string> =
  {
    watches: "watches",
    news: "news",
    calendar: "calendar",
    email: "email",
    open_items: "open items",
  };

/** A briefing's sections and topics in words. */
export function describeBriefing(briefing: JobBriefing): string {
  const sections = briefing.sections
    .map((section) => BRIEFING_SECTION_NAMES[section])
    .join(", ");
  return `${sections}${briefing.topics.length > 0 ? ` · topics: ${briefing.topics.join(", ")}` : ""} · about ${briefing.maxWords} words`;
}

/** A briefing run's coverage in words, for its history. */
export function briefingRunLabel(run: JobRun): string | undefined {
  const briefing = run.briefing;
  if (!briefing || run.status !== "completed") return undefined;
  const changes = `${briefing.watchChanges} watch ${briefing.watchChanges === 1 ? "change" : "changes"}`;
  if (!briefing.unsourced) return changes;
  return `${changes} · ${briefing.unsourced} ${briefing.unsourced === 1 ? "item" : "items"} without a source`;
}

/** A URL's host, for a short label. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** A run's model use in words. */
export function usageLabel(run: JobRun): string | undefined {
  if (!run.usage) return undefined;
  const tokens = run.usage.inputTokens + run.usage.outputTokens;
  return `${run.usage.requests} model ${run.usage.requests === 1 ? "request" : "requests"}, ${tokens.toLocaleString()} tokens`;
}

/** Runaway-guard notices: the chat keeps working until the owner stops it. */
function offersStop(entry: InboxEntry): boolean {
  return (
    entry.kind === "session_long_running" || entry.kind === "session_stuck"
  );
}

/** The browser's own time zone, the default for new daily and weekly jobs. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** A short description, such as "Weekdays at 07:30 (Australia/Sydney)". */
export function describeSchedule(schedule: JobSchedule): string {
  switch (schedule.kind) {
    case "interval": {
      const minutes = schedule.everyMinutes;
      if (minutes % 60 === 0) {
        const hours = minutes / 60;
        return hours === 1 ? "Every hour" : `Every ${hours} hours`;
      }
      return `Every ${minutes} minutes`;
    }
    case "daily":
      return `Daily at ${schedule.time} (${schedule.timeZone})`;
    case "weekly": {
      const days = WEEKDAYS.filter((day) => schedule.days.includes(day));
      const weekdays = ["mon", "tue", "wed", "thu", "fri"];
      const label =
        days.length === 7
          ? "Every day"
          : days.length === 5 &&
              weekdays.every((day) => days.includes(day as Weekday))
            ? "Weekdays"
            : days.length === 2 && days.includes("sat") && days.includes("sun")
              ? "Weekends"
              : days.map((day) => WEEKDAY_LABELS[day]).join(", ");
      return `${label} at ${schedule.time} (${schedule.timeZone})`;
    }
  }
}

export interface JobFormState {
  name: string;
  projectId: string;
  prompt: string;
  kind: JobSchedule["kind"];
  every: string;
  unit: "minutes" | "hours";
  time: string;
  days: Weekday[];
  timeZone: string;
  model: string;
  effort: string;
  approvalMode: "autonomous" | "ask";
  enabled: boolean;
}

export function emptyJobForm(
  projectId: string,
  timeZone: string,
): JobFormState {
  return {
    name: "",
    projectId,
    prompt: "",
    kind: "daily",
    every: "1",
    unit: "hours",
    time: "07:30",
    days: ["mon", "tue", "wed", "thu", "fri"],
    timeZone,
    model: "",
    effort: "",
    approvalMode: "autonomous",
    enabled: true,
  };
}

export function jobFormFromJob(job: Job, timeZone: string): JobFormState {
  const form = emptyJobForm(job.projectId, timeZone);
  const schedule = job.schedule;
  return {
    ...form,
    name: job.name,
    prompt: job.prompt,
    kind: schedule.kind,
    ...(schedule.kind === "interval"
      ? schedule.everyMinutes % 60 === 0
        ? { every: String(schedule.everyMinutes / 60), unit: "hours" as const }
        : { every: String(schedule.everyMinutes), unit: "minutes" as const }
      : {
          time: schedule.time,
          timeZone: schedule.timeZone,
          ...(schedule.kind === "weekly" ? { days: [...schedule.days] } : {}),
        }),
    model: job.model ?? "",
    effort: job.reasoningEffort ?? "",
    approvalMode: job.approvalMode,
    enabled: job.enabled,
  };
}

/** The schedule a form describes, or why it cannot be saved. */
export function scheduleFromForm(
  form: JobFormState,
): { schedule: JobSchedule } | { error: string } {
  switch (form.kind) {
    case "interval": {
      const every = Number(form.every);
      if (!Number.isInteger(every) || every < 1) {
        return { error: "Enter a whole number." };
      }
      const everyMinutes = form.unit === "hours" ? every * 60 : every;
      if (everyMinutes < 15) {
        return { error: "Runs can repeat every 15 minutes at most often." };
      }
      if (everyMinutes > 7 * 24 * 60) {
        return { error: "Runs must repeat at least once a week." };
      }
      return { schedule: { kind: "interval", everyMinutes } };
    }
    case "daily":
    case "weekly": {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/u.test(form.time)) {
        return { error: "Use a 24-hour time such as 07:30." };
      }
      const timeZone = form.timeZone.trim();
      if (!timeZone) return { error: "Enter a time zone." };
      if (form.kind === "daily") {
        return { schedule: { kind: "daily", time: form.time, timeZone } };
      }
      const days = WEEKDAYS.filter((day) => form.days.includes(day));
      if (days.length === 0) return { error: "Pick at least one day." };
      return { schedule: { kind: "weekly", days, time: form.time, timeZone } };
    }
  }
}

/**
 * The request body for a form: every field for a new job; a change also
 * clears the model and thinking level when they are back to defaults.
 */
export function jobRequestBody(
  form: JobFormState,
  schedule: JobSchedule,
  isNew: boolean,
): Record<string, unknown> {
  return {
    name: form.name.trim(),
    projectId: form.projectId,
    prompt: form.prompt,
    schedule,
    enabled: form.enabled,
    approvalMode: form.approvalMode,
    ...(form.model ? { model: form.model } : isNew ? {} : { model: null }),
    ...(form.model && form.effort
      ? { reasoningEffort: form.effort }
      : isNew
        ? {}
        : { reasoningEffort: null }),
  };
}

const startOfDay = (at: number) => {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

/** "Today", "Yesterday", or the date. */
export function inboxDayLabel(at: number, now: number): string {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return new Date(at).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

/** Entries (newest first) grouped by day, keeping their order. */
export function groupInboxEntries(
  entries: readonly InboxEntry[],
  now: number,
): Array<{ label: string; entries: InboxEntry[] }> {
  const groups: Array<{ label: string; entries: InboxEntry[] }> = [];
  for (const entry of entries) {
    const label = inboxDayLabel(entry.createdAt, now);
    const last = groups.at(-1);
    if (last?.label === label) last.entries.push(entry);
    else groups.push({ label, entries: [entry] });
  }
  return groups;
}

function formatWhen(at: number | undefined): string {
  if (at === undefined) return "";
  return new Date(at).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Open a chat from a link: select its project (and the chat) on the
 * server, then reload into the other project or load the chat in this one.
 */
export async function openAssistantChat(params: {
  projectId: string;
  sessionId: string;
  loadSession: (sessionId: string) => void;
  reloadPage: () => void;
}): Promise<void> {
  const before = await requestJson<{ activeProjectId: string | null }>(
    "/api/ask-agent/projects",
  );
  await requestJson("/api/ask-agent/projects/select", {
    method: "POST",
    body: { projectId: params.projectId, sessionId: params.sessionId },
  });
  if (before.activeProjectId === params.projectId) {
    params.loadSession(params.sessionId);
  } else {
    params.reloadPage();
  }
}

/** The banner shown while the server is drained for an upgrade. */
export function maintenanceNotice(
  maintenance: "draining" | "drained" | undefined,
): string | undefined {
  if (maintenance === "draining") {
    return "Upgrading: new chats, tasks and scheduled runs wait while running work finishes.";
  }
  if (maintenance === "drained") {
    return "Upgrading: new chats, tasks and scheduled runs wait until the upgrade is done.";
  }
  return undefined;
}

export function AssistantHub({
  inboxUnread = 0,
  revision = 0,
  maintenance,
  version,
  loadSession,
  reloadPage,
}: {
  inboxUnread?: number;
  revision?: number;
  maintenance?: "draining" | "drained";
  version?: string;
  loadSession: (sessionId: string) => void;
  reloadPage: () => void;
}) {
  const notice = maintenanceNotice(maintenance);
  // Back from an MCP server's sign-in page: show how it went.
  const [view, setView] = useState<
    "jobs" | "inbox" | "github" | "tasks" | "mcp" | "memory" | "settings" | null
  >(() => (signInReturnNotice(window.location.search) ? "mcp" : null));
  const [taskId, setTaskId] = useState<string | undefined>(undefined);
  const openChat = async (projectId: string, sessionId: string) => {
    await openAssistantChat({ projectId, sessionId, loadSession, reloadPage });
    setView(null);
  };
  const openTask = (id?: string) => {
    setTaskId(id);
    setView("tasks");
  };
  // A notification (or its link) marks its entry read and opens its task
  // or chat, or the inbox when it has neither.
  const openTarget = (target: OpenTarget) => {
    void (async () => {
      if (target.entryId) {
        await requestJson("/api/inbox/read", {
          method: "POST",
          body: { ids: [target.entryId] },
        }).catch(() => undefined);
      }
      if (target.taskId) {
        openTask(target.taskId);
      } else if (target.projectId && target.sessionId) {
        await openChat(target.projectId, target.sessionId);
      } else {
        setView("inbox");
      }
    })().catch(() => setView("inbox"));
  };
  useNotificationLinks(openTarget);
  useLocalInboxNotifications(revision, openTarget);
  // A task card in the chat opens its task here.
  useEffect(() => {
    const onOpenTask = (event: Event) => {
      const id = (event as CustomEvent<unknown>).detail;
      if (typeof id === "string") openTask(id);
    };
    window.addEventListener(OPEN_TASK_EVENT, onOpenTask);
    return () => window.removeEventListener(OPEN_TASK_EVENT, onOpenTask);
  }, []);
  return (
    <>
      <nav class="assistant-hub" aria-label="Assistant">
        <button
          type="button"
          class="assistant-hub-button"
          aria-haspopup="dialog"
          title="Scheduled jobs"
          onClick={() => setView("jobs")}
        >
          <i class="codicon codicon-history" aria-hidden="true" />
          <span>Jobs</span>
        </button>
        <button
          type="button"
          class="assistant-hub-button"
          aria-haspopup="dialog"
          aria-label={
            inboxUnread > 0 ? `Inbox (${inboxUnread} unread)` : "Inbox"
          }
          title={inboxUnread > 0 ? `Inbox (${inboxUnread} unread)` : "Inbox"}
          onClick={() => setView("inbox")}
        >
          <i class="codicon codicon-inbox" aria-hidden="true" />
          <span>Inbox</span>
          {inboxUnread > 0 && (
            <span class="assistant-hub-badge" aria-hidden="true">
              {inboxUnread > 99 ? "99+" : inboxUnread}
            </span>
          )}
        </button>
        <button
          type="button"
          class="assistant-hub-button"
          aria-haspopup="dialog"
          title="Coding tasks"
          onClick={() => openTask()}
        >
          <i class="codicon codicon-git-pull-request" aria-hidden="true" />
          <span>Tasks</span>
        </button>
        <button
          type="button"
          class="assistant-hub-button"
          aria-haspopup="dialog"
          title="GitHub connections"
          onClick={() => setView("github")}
        >
          <i class="codicon codicon-github" aria-hidden="true" />
          <span>GitHub</span>
        </button>
        <button
          type="button"
          class="assistant-hub-button"
          aria-haspopup="dialog"
          title="MCP servers (other services the assistant can use)"
          onClick={() => setView("mcp")}
        >
          <i class="codicon codicon-plug" aria-hidden="true" />
          <span>MCP</span>
        </button>
        <button
          type="button"
          class="assistant-hub-button"
          aria-haspopup="dialog"
          title="What the Assistant remembers about you"
          onClick={() => setView("memory")}
        >
          <i class="codicon codicon-lightbulb" aria-hidden="true" />
          <span>Memory</span>
        </button>
        <button
          type="button"
          class="assistant-hub-button"
          aria-haspopup="dialog"
          title="Settings (name, persona, time zone and quiet hours)"
          onClick={() => setView("settings")}
        >
          <i class="codicon codicon-settings-gear" aria-hidden="true" />
          <span>Settings</span>
        </button>
      </nav>
      {notice && (
        <p class="assistant-maintenance" role="status">
          <i class="codicon codicon-sync" aria-hidden="true" /> {notice}
        </p>
      )}
      {view === "jobs" && (
        <JobsPanel
          revision={revision}
          onClose={() => setView(null)}
          openChat={openChat}
        />
      )}
      {view === "inbox" && (
        <InboxPanel
          revision={revision}
          onClose={() => setView(null)}
          openChat={openChat}
          openTask={openTask}
          {...(version ? { version } : {})}
        />
      )}
      {view === "tasks" && (
        <TasksPanel
          key={taskId ?? "list"}
          revision={revision}
          onClose={() => setView(null)}
          initialTaskId={taskId}
          openTaskChat={(projectId, sessionId) =>
            void openChat(projectId, sessionId)
          }
        />
      )}
      {view === "github" && <GitHubPanel onClose={() => setView(null)} />}
      {view === "settings" && <SettingsPanel onClose={() => setView(null)} />}
      {view === "memory" && (
        <MemoryPanel onClose={() => setView(null)} openChat={openChat} />
      )}
      {view === "mcp" && (
        <McpPanel
          onClose={() => {
            // Drop the sign-in result so a reload does not show it again.
            if (signInReturnNotice(window.location.search)) {
              window.history.replaceState(null, "", window.location.pathname);
            }
            setView(null);
          }}
        />
      )}
    </>
  );
}

type JobsView =
  | { kind: "list" }
  | { kind: "edit"; job: Job | null }
  | { kind: "history"; job: Job };

export function JobsPanel({
  revision,
  onClose,
  openChat,
}: {
  revision: number;
  onClose: () => void;
  openChat: (projectId: string, sessionId: string) => Promise<void>;
}) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [view, setView] = useState<JobsView>({ kind: "list" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      requestJson<{ jobs: Job[] }>("/api/jobs"),
      requestJson<{
        activeProjectId: string | null;
        projects: ProjectOption[];
      }>("/api/ask-agent/projects"),
      requestJson<{ models: ModelOption[] }>("/api/ask-agent/models").catch(
        () => ({ models: [] }),
      ),
    ]).then(
      ([jobList, projectList, modelList]) => {
        if (cancelled) return;
        setJobs(jobList.jobs);
        setProjects(projectList.projects);
        setActiveProjectId(projectList.activeProjectId);
        setModels(modelList.models);
      },
      (caught: unknown) => {
        if (!cancelled) setError(errorText(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [revision, reloads]);

  const reload = () => setReloads((count) => count + 1);
  const projectLabel = (projectId: string) =>
    projects.find((project) => project.id === projectId)?.label ?? projectId;

  const act = async (jobId: string, action: () => Promise<unknown>) => {
    setBusy(jobId);
    setError(null);
    try {
      await action();
      reload();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(null);
    }
  };

  const open = (projectId: string, sessionId: string) => {
    setError(null);
    openChat(projectId, sessionId).catch((caught: unknown) =>
      setError(errorText(caught)),
    );
  };

  if (view.kind === "edit") {
    return (
      <Dialog title={view.job ? "Edit job" : "New job"} onClose={onClose} wide>
        <JobForm
          job={view.job}
          projects={projects}
          defaultProjectId={activeProjectId ?? projects[0]?.id ?? ""}
          models={models}
          onCancel={() => setView({ kind: "list" })}
          onSaved={() => {
            setView({ kind: "list" });
            reload();
          }}
        />
      </Dialog>
    );
  }

  if (view.kind === "history") {
    return (
      <Dialog
        title={`${view.job.name}: runs`}
        onClose={onClose}
        wide
        actions={
          <button
            type="button"
            class="assistant-panel-action"
            onClick={() => setView({ kind: "list" })}
          >
            <i class="codicon codicon-arrow-left" aria-hidden="true" /> Jobs
          </button>
        }
      >
        <JobHistory job={view.job} revision={revision} openChat={open} />
        {error && (
          <p class="assistant-project-error" role="alert">
            {error}
          </p>
        )}
      </Dialog>
    );
  }

  return (
    <Dialog
      title="Jobs"
      onClose={onClose}
      wide
      actions={
        <button
          type="button"
          class="assistant-panel-action primary"
          disabled={projects.length === 0}
          onClick={() => setView({ kind: "edit", job: null })}
        >
          <i class="codicon codicon-add" aria-hidden="true" /> New job
        </button>
      }
    >
      {error && (
        <p class="assistant-project-error" role="alert">
          {error}
        </p>
      )}
      {!jobs ? (
        <p class="assistant-project-hint">{error ? "" : "Loading…"}</p>
      ) : jobs.length === 0 ? (
        <div class="assistant-panel-empty">
          <i class="codicon codicon-history" aria-hidden="true" />
          <p>
            No jobs yet. A job sends a prompt on a schedule, each run in a new
            chat, and works while every window is closed.
          </p>
        </div>
      ) : (
        <ul class="assistant-job-list">
          {jobs.map((job) => {
            const active = job.activeRun;
            const last = job.lastRun && !active ? job.lastRun : undefined;
            return (
              <li class="assistant-job" key={job.id}>
                <div class="assistant-job-main">
                  <strong>{job.name}</strong>
                  {job.watch && (
                    <span class="assistant-job-meta" title={job.watch.url}>
                      <i class="codicon codicon-eye" aria-hidden="true" />{" "}
                      Watches {hostOf(job.watch.url)}
                      {job.watch.selector ? ` (${job.watch.selector})` : ""}
                      {job.watchState?.checkedAt
                        ? ` · checked ${formatWhen(job.watchState.checkedAt)}`
                        : ""}
                    </span>
                  )}
                  {job.briefing && (
                    <span class="assistant-job-meta">
                      <i class="codicon codicon-megaphone" aria-hidden="true" />{" "}
                      Briefing: {describeBriefing(job.briefing)}
                    </span>
                  )}
                  <span class="assistant-job-meta">
                    {job.watch ? "Checks " : ""}
                    {describeSchedule(job.schedule)} ·{" "}
                    {projectLabel(job.projectId)}
                  </span>
                  <span class="assistant-job-meta">
                    {active ? (
                      <span
                        class={`assistant-run-status tone-${RUN_STATUS[active.status].tone}`}
                      >
                        {runStatusLabel(active.status)}
                      </span>
                    ) : job.enabled ? (
                      job.nextRunAt ? (
                        `Next ${formatWhen(job.nextRunAt)}`
                      ) : (
                        "Not scheduled"
                      )
                    ) : (
                      "Paused"
                    )}
                    {last && (
                      <>
                        {" · Last: "}
                        <span
                          class={`assistant-run-status tone-${RUN_STATUS[last.status].tone}`}
                        >
                          {runStatusLabel(last.status)}
                        </span>{" "}
                        {formatWhen(last.finishedAt ?? last.updatedAt)}
                      </>
                    )}
                  </span>
                </div>
                <div class="assistant-job-actions">
                  <label
                    class="assistant-switch"
                    title={job.enabled ? "Pause" : "Resume"}
                  >
                    <input
                      type="checkbox"
                      role="switch"
                      aria-label={`Run ${job.name} on its schedule`}
                      checked={job.enabled}
                      disabled={busy === job.id}
                      onChange={(event) => {
                        const enabled = event.currentTarget.checked;
                        void act(job.id, () =>
                          requestJson(
                            `/api/jobs/${encodeURIComponent(job.id)}`,
                            { method: "PATCH", body: { enabled } },
                          ),
                        );
                      }}
                    />
                    <span aria-hidden="true" />
                  </label>
                  {active?.sessionId ? (
                    <button
                      type="button"
                      onClick={() => open(job.projectId, active.sessionId!)}
                    >
                      <i class="codicon codicon-eye" aria-hidden="true" />{" "}
                      Follow
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busy === job.id || Boolean(active)}
                      onClick={() =>
                        void act(job.id, () =>
                          requestJson(
                            `/api/jobs/${encodeURIComponent(job.id)}/run`,
                            { method: "POST", body: {} },
                          ),
                        )
                      }
                    >
                      <i class="codicon codicon-play" aria-hidden="true" /> Run
                      now
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setView({ kind: "history", job })}
                  >
                    History
                  </button>
                  <button
                    type="button"
                    onClick={() => setView({ kind: "edit", job })}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    class="icon-button"
                    aria-label={`Delete ${job.name}`}
                    disabled={busy === job.id}
                    onClick={() => {
                      if (
                        !window.confirm(
                          `Delete "${job.name}"? Its run history goes too; its chats stay.`,
                        )
                      ) {
                        return;
                      }
                      void act(job.id, () =>
                        requestJson(`/api/jobs/${encodeURIComponent(job.id)}`, {
                          method: "DELETE",
                        }),
                      );
                    }}
                  >
                    <i class="codicon codicon-trash" aria-hidden="true" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}

function JobHistory({
  job,
  revision,
  openChat,
}: {
  job: Job;
  revision: number;
  openChat: (projectId: string, sessionId: string) => void;
}) {
  const [runs, setRuns] = useState<JobRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    requestJson<{ runs: JobRun[] }>(
      `/api/jobs/${encodeURIComponent(job.id)}/runs`,
    ).then(
      (body) => {
        if (!cancelled) setRuns(body.runs);
      },
      (caught: unknown) => {
        if (!cancelled) setError(errorText(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [job.id, revision]);

  if (!runs) {
    return <p class="assistant-project-hint">{error ?? "Loading…"}</p>;
  }
  if (runs.length === 0) {
    return <p class="assistant-project-hint">No runs yet.</p>;
  }
  return (
    <ul class="assistant-run-list">
      {runs.map((run) => (
        <li class="assistant-run" key={run.runId}>
          <div class="assistant-job-main">
            <span>
              <span
                class={`assistant-run-status tone-${RUN_STATUS[run.status].tone}`}
              >
                {runStatusLabel(run.status)}
              </span>{" "}
              <span class="assistant-job-meta">
                {formatWhen(run.startedAt ?? run.createdAt)}
                {run.trigger === "manual"
                  ? " · run now"
                  : run.trigger === "catch_up"
                    ? " · caught up"
                    : ""}
                {watchOutcomeLabel(run) ? ` · ${watchOutcomeLabel(run)}` : ""}
                {briefingRunLabel(run) ? ` · ${briefingRunLabel(run)}` : ""}
                {usageLabel(run) ? ` · ${usageLabel(run)}` : ""}
              </span>
            </span>
            {(run.summary || run.errorDetail || run.error) && (
              <span class="assistant-run-summary">
                {run.summary ?? run.errorDetail ?? run.error}
              </span>
            )}
          </div>
          {run.sessionId && (
            <button
              type="button"
              onClick={() => openChat(run.projectId, run.sessionId!)}
            >
              Open chat
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

export function JobForm({
  job,
  projects,
  defaultProjectId,
  models,
  onCancel,
  onSaved,
}: {
  job: Job | null;
  projects: ProjectOption[];
  defaultProjectId: string;
  models: ModelOption[];
  onCancel: () => void;
  onSaved: (job: Job) => void;
}) {
  const [form, setForm] = useState<JobFormState>(() =>
    job
      ? jobFormFromJob(job, browserTimeZone())
      : emptyJobForm(defaultProjectId, browserTimeZone()),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = (patch: Partial<JobFormState>) =>
    setForm((current) => ({ ...current, ...patch }));
  const efforts =
    models.find((option) => option.id === form.model)?.reasoningEfforts ?? [];

  const submit = async (event: Event) => {
    event.preventDefault();
    if (busy) return;
    if (!form.name.trim()) return setError("Give the job a name.");
    if (!form.prompt.trim()) {
      return setError(
        job?.watch
          ? "Say what matters about the page."
          : job?.briefing
            ? "Add a note for the briefing."
            : "Write what each run should ask.",
      );
    }
    const parsed = scheduleFromForm(form);
    if ("error" in parsed) return setError(parsed.error);
    setBusy(true);
    setError(null);
    try {
      const body = jobRequestBody(form, parsed.schedule, job === null);
      const result = await requestJson<{ job: Job }>(
        job ? `/api/jobs/${encodeURIComponent(job.id)}` : "/api/jobs",
        { method: job ? "PATCH" : "POST", body },
      );
      onSaved(result.job);
    } catch (caught) {
      setError(errorText(caught));
      setBusy(false);
    }
  };

  return (
    <form class="assistant-project-form" onSubmit={submit}>
      <div class="assistant-project-row">
        <label>
          <span>Name</span>
          <input
            value={form.name}
            maxLength={100}
            placeholder="Morning brief"
            onInput={(event) => update({ name: event.currentTarget.value })}
          />
        </label>
        <label>
          <span>Project</span>
          <select
            value={form.projectId}
            onChange={(event) =>
              update({ projectId: event.currentTarget.value })
            }
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {job?.watch && (
        <p class="assistant-project-hint">
          Watches {job.watch.url}
          {job.watch.selector ? ` (${job.watch.selector})` : ""}. To change the
          page, ask in a chat.
        </p>
      )}
      <label>
        <span>
          {job?.watch
            ? "What matters (a model reads only changes, against this)"
            : job?.briefing
              ? "Notes for each briefing (sections and topics: ask in a chat)"
              : "Prompt (sent to a new chat on each run)"}
        </span>
        <textarea
          rows={5}
          value={form.prompt}
          maxLength={20_000}
          placeholder="Check my project's open issues and brief me on anything new."
          onInput={(event) => update({ prompt: event.currentTarget.value })}
        />
      </label>
      <fieldset>
        <legend>When</legend>
        <div class="assistant-job-schedule">
          <select
            aria-label="Repeat"
            value={form.kind}
            onChange={(event) =>
              update({
                kind: event.currentTarget.value as JobSchedule["kind"],
              })
            }
          >
            <option value="interval">Every…</option>
            <option value="daily">Daily</option>
            <option value="weekly">On days of the week</option>
          </select>
          {form.kind === "interval" ? (
            <>
              <input
                aria-label="Every"
                type="number"
                min={1}
                inputMode="numeric"
                value={form.every}
                onInput={(event) =>
                  update({ every: event.currentTarget.value })
                }
              />
              <select
                aria-label="Unit"
                value={form.unit}
                onChange={(event) =>
                  update({
                    unit: event.currentTarget.value as JobFormState["unit"],
                  })
                }
              >
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
              </select>
            </>
          ) : (
            <>
              <input
                aria-label="Time"
                type="time"
                value={form.time}
                onInput={(event) => update({ time: event.currentTarget.value })}
              />
              <input
                aria-label="Time zone"
                value={form.timeZone}
                placeholder="Australia/Sydney"
                onInput={(event) =>
                  update({ timeZone: event.currentTarget.value })
                }
              />
            </>
          )}
        </div>
        {form.kind === "weekly" && (
          <div class="assistant-job-days" role="group" aria-label="Days">
            {WEEKDAYS.map((day) => (
              <label key={day} class="assistant-job-day">
                <input
                  type="checkbox"
                  checked={form.days.includes(day)}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    update({
                      days: checked
                        ? [...form.days, day]
                        : form.days.filter((item) => item !== day),
                    });
                  }}
                />
                <span>{WEEKDAY_LABELS[day]}</span>
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <div class="assistant-project-row">
        <label>
          <span>Model</span>
          <select
            value={form.model}
            onChange={(event) =>
              update({ model: event.currentTarget.value, effort: "" })
            }
          >
            <option value="">Project default</option>
            {models.map((option) => (
              <option key={option.id} value={option.id}>
                {option.displayName ?? option.id}
                {option.providerDisplayName
                  ? ` · ${option.providerDisplayName}`
                  : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Thinking</span>
          <select
            value={form.effort}
            disabled={efforts.length === 0}
            onChange={(event) => update({ effort: event.currentTarget.value })}
          >
            <option value="">Model default</option>
            {efforts.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </div>
      <fieldset>
        <legend>While it runs</legend>
        <label class="assistant-project-choice">
          <input
            type="radio"
            name="job-approval"
            checked={form.approvalMode === "autonomous"}
            onChange={() => update({ approvalMode: "autonomous" })}
          />
          <span>
            <strong>Work on its own</strong>
            <small>
              Edits and commands inside the project go ahead; protected paths
              and background commands still wait for you.
            </small>
          </span>
        </label>
        <label class="assistant-project-choice">
          <input
            type="radio"
            name="job-approval"
            checked={form.approvalMode === "ask"}
            onChange={() => update({ approvalMode: "ask" })}
          />
          <span>
            <strong>Ask before each change</strong>
            <small>
              The run pauses in your inbox until you allow or deny, and is
              cancelled after 12 hours.
            </small>
          </span>
        </label>
      </fieldset>
      <label class="assistant-job-enabled">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(event) => update({ enabled: event.currentTarget.checked })}
        />
        <span>Run on this schedule (off: only when you press Run now)</span>
      </label>
      {error && (
        <div class="assistant-project-error" role="alert">
          <p>{error}</p>
        </div>
      )}
      <footer>
        <button type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button class="primary" type="submit" disabled={busy}>
          {busy ? "Saving…" : job ? "Save" : "Create job"}
        </button>
      </footer>
    </form>
  );
}

export function InboxPanel({
  revision,
  onClose,
  openChat,
  openTask,
  version,
  now = Date.now,
}: {
  revision: number;
  onClose: () => void;
  openChat: (projectId: string, sessionId: string) => Promise<void>;
  /** Opens a coding task's entry; without it those entries open nothing. */
  openTask?: (taskId: string) => void;
  /** The running server's version, shown under the settings. */
  version?: string;
  now?: () => number;
}) {
  const [entries, setEntries] = useState<InboxEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let cancelled = false;
    requestJson<{ entries: InboxEntry[] }>("/api/inbox").then(
      (body) => {
        if (!cancelled) setEntries(body.entries);
      },
      (caught: unknown) => {
        if (!cancelled) setError(errorText(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [revision, reloads]);

  const markRead = async (body: { ids: string[] } | { all: true }) => {
    setError(null);
    // Shown read at once; the server's count follows.
    setEntries(
      (current) =>
        current?.map((entry) =>
          "all" in body || body.ids.includes(entry.id)
            ? { ...entry, read: true }
            : entry,
        ) ?? current,
    );
    try {
      await requestJson("/api/inbox/read", { method: "POST", body });
    } catch (caught) {
      setError(errorText(caught));
      setReloads((count) => count + 1);
    }
  };

  const act = async (entry: InboxEntry, action: "stop" | "keep_going") => {
    setError(null);
    setEntries(
      (current) =>
        current?.map((candidate) =>
          candidate.id === entry.id ? { ...candidate, read: true } : candidate,
        ) ?? current,
    );
    try {
      await requestJson("/api/inbox/act", {
        method: "POST",
        body: { id: entry.id, action },
      });
    } catch (caught) {
      setError(errorText(caught));
      setReloads((count) => count + 1);
    }
  };

  const unread = entries?.filter((entry) => !entry.read).length ?? 0;

  return (
    <Dialog
      title="Inbox"
      onClose={onClose}
      wide
      actions={
        unread > 0 ? (
          <button
            type="button"
            class="assistant-panel-action"
            onClick={() => void markRead({ all: true })}
          >
            <i class="codicon codicon-check-all" aria-hidden="true" /> Mark all
            read
          </button>
        ) : undefined
      }
    >
      <NotificationSettings />
      <BackupSettings />
      {version && (
        <p class="assistant-project-hint">AgentLink Assistant {version}</p>
      )}
      {error && (
        <p class="assistant-project-error" role="alert">
          {error}
        </p>
      )}
      {!entries ? (
        <p class="assistant-project-hint">{error ? "" : "Loading…"}</p>
      ) : entries.length === 0 ? (
        <div class="assistant-panel-empty">
          <i class="codicon codicon-inbox" aria-hidden="true" />
          <p>
            Nothing here yet. Finished jobs and coding tasks, failures and
            approvals waiting for you show up here.
          </p>
        </div>
      ) : (
        groupInboxEntries(entries, now()).map((group) => (
          <section class="assistant-inbox-group" key={group.label}>
            <h3>{group.label}</h3>
            <ul class="assistant-inbox-list">
              {group.entries.map((entry) => {
                const opensTask = Boolean(entry.taskId && openTask);
                return (
                  <li
                    key={entry.id}
                    class={`assistant-inbox-entry kind-${entry.kind}${entry.read ? "" : " unread"}`}
                  >
                    <button
                      type="button"
                      class="assistant-inbox-open"
                      disabled={!opensTask && !entry.sessionId && entry.read}
                      aria-label={`${entry.read ? "" : "Unread: "}${entry.title}`}
                      onClick={() => {
                        if (!entry.read) void markRead({ ids: [entry.id] });
                        if (opensTask && entry.taskId) {
                          openTask?.(entry.taskId);
                          return;
                        }
                        if (!entry.sessionId) return;
                        openChat(entry.projectId, entry.sessionId).catch(
                          (caught: unknown) => setError(errorText(caught)),
                        );
                      }}
                    >
                      <i
                        class={`codicon codicon-${INBOX_ICONS[entry.kind] ?? "bell"}`}
                        aria-hidden="true"
                      />
                      <span class="assistant-inbox-text">
                        <strong>{entry.title}</strong>
                        {entry.body && <span>{entry.body}</span>}
                      </span>
                      <time dateTime={new Date(entry.createdAt).toISOString()}>
                        {formatClock(entry.createdAt)}
                      </time>
                    </button>
                    {!entry.read && offersStop(entry) && (
                      <span class="assistant-inbox-actions">
                        <button
                          type="button"
                          class="assistant-panel-action"
                          onClick={() => void act(entry, "stop")}
                        >
                          <i
                            class="codicon codicon-debug-stop"
                            aria-hidden="true"
                          />{" "}
                          Stop
                        </button>
                        <button
                          type="button"
                          class="assistant-panel-action"
                          onClick={() => void act(entry, "keep_going")}
                        >
                          Keep going
                        </button>
                      </span>
                    )}
                    {!entry.read && !offersStop(entry) && (
                      <button
                        type="button"
                        class="icon-button"
                        aria-label={`Mark "${entry.title}" read`}
                        title="Mark read"
                        onClick={() => void markRead({ ids: [entry.id] })}
                      >
                        <i class="codicon codicon-check" aria-hidden="true" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </Dialog>
  );
}
