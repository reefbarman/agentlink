import { Dialog, errorText, requestJson } from "./AssistantProjects";
import { useEffect, useState } from "preact/hooks";

/**
 * Coding tasks in the AgentLink Assistant: each one's state, branch and
 * pull request; its evidence for the current commit (validation commands
 * and review findings); Stop, Resume, Publish and Delete; and its
 * implementation and review chats, read-only (task chats live in hidden
 * projects, so the chat list never shows them).
 */

export type TaskState =
  | "queued"
  | "preparing"
  | "implementing"
  | "awaiting_approval"
  | "validating"
  | "reviewing"
  | "fixing"
  | "ready"
  | "publishing"
  | "published"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "blocked_auth"
  | "blocked_quota"
  | "blocked_review"
  | "editing";

export interface ValidationCommandResult {
  command: string;
  exitCode?: number;
  timedOut: boolean;
  durationMs: number;
  outputTail: string;
}

export interface ReviewFinding {
  severity: "blocking" | "suggestion";
  file?: string;
  line?: number;
  reason: string;
}

export interface TaskEvidence {
  implementation?: { commit: string; at: number };
  validation?: {
    commit: string;
    at: number;
    passed: boolean;
    commands: ValidationCommandResult[];
    changedFiles?: string;
  };
  review?: {
    commit: string;
    at: number;
    model: string;
    sessionId: string;
    verdict: "approve" | "changes_requested";
    findings: ReviewFinding[];
  };
}

export interface Task {
  id: string;
  projectId: string;
  repository: string;
  objective: string;
  branch: string;
  state: TaskState;
  baseBranch?: string;
  resolvedBaseBranch?: string;
  /** Repositories the task reads, read-only. */
  references?: string[];
  baseCommit?: string;
  headCommit?: string;
  commits?: string[];
  fixRounds?: number;
  openFindings?: number;
  sessionId?: string;
  /** The chat that started the task; its own chat is listed beside it. */
  origin?: { projectId: string; sessionId: string };
  pullRequest?: { number: number; url: string };
  publishedCommit?: string;
  summary?: string;
  error?: string;
  errorDetail?: string;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  /** Evidence for `headCommit`. */
  current: TaskEvidence;
}

export interface TaskDetail {
  task: Task;
  events: { at: number; state: TaskState; error?: string }[];
  /** The repository's validation commands now. */
  validation: string[];
  /** The repository's publish permission, if any. */
  publish: { connectionId: string; grantedAt: number } | null;
  /** The browser editor: available, and open now (`ro` or `rw`). */
  editor?: { enabled: boolean; mode?: "ro" | "rw" };
}

type Tone = "busy" | "ok" | "warn" | "bad" | "muted";

const STATES: Record<TaskState, { label: string; tone: Tone }> = {
  queued: { label: "Queued", tone: "busy" },
  preparing: { label: "Cloning", tone: "busy" },
  implementing: { label: "Working", tone: "busy" },
  awaiting_approval: { label: "Needs your approval", tone: "warn" },
  validating: { label: "Validating", tone: "busy" },
  reviewing: { label: "In review", tone: "busy" },
  fixing: { label: "Fixing findings", tone: "busy" },
  ready: { label: "Ready", tone: "ok" },
  publishing: { label: "Publishing", tone: "busy" },
  published: { label: "Draft PR open", tone: "ok" },
  failed: { label: "Failed", tone: "bad" },
  cancelled: { label: "Cancelled", tone: "muted" },
  interrupted: { label: "Interrupted", tone: "bad" },
  blocked_auth: { label: "Blocked: sign-in", tone: "bad" },
  blocked_quota: { label: "Blocked: limits", tone: "bad" },
  blocked_review: { label: "Blocked: no reviewer", tone: "warn" },
  editing: { label: "You're editing", tone: "warn" },
};

const ACTIVE: readonly TaskState[] = [
  "queued",
  "preparing",
  "implementing",
  "awaiting_approval",
  "validating",
  "reviewing",
  "fixing",
  "publishing",
];

const RESUMABLE: readonly TaskState[] = [
  "failed",
  "cancelled",
  "interrupted",
  "blocked_auth",
  "blocked_quota",
  "blocked_review",
];

export function taskStateLabel(state: TaskState): {
  label: string;
  tone: Tone;
} {
  return STATES[state] ?? { label: state, tone: "muted" };
}

/** The objective's first line. */
export function taskName(objective: string): string {
  return (
    objective
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? "Coding task"
  );
}

/** A coding task as the chat that started it shows it (snapshot `tasks`). */
export interface ChatTaskCard {
  id: string;
  state: TaskState;
  objective: string;
  repository: string;
  pullRequest?: string;
  updatedAt: number;
}

type EditorAction = "open" | "take_over" | "hand_back";

/**
 * Open, take over or hand back a task's folder in the browser editor.
 * The editor opens in a new tab, opened before the request so browsers
 * do not block it as a pop-up.
 */
export async function taskEditorAction(
  taskId: string,
  action: EditorAction,
): Promise<void> {
  const tab = action === "hand_back" ? null : window.open("", "_blank");
  try {
    const body = await requestJson<{ url?: string }>(
      `/api/tasks/${encodeURIComponent(taskId)}/editor`,
      { method: "POST", body: { action } },
    );
    if (tab && body.url) {
      tab.opener = null;
      tab.location.href = body.url;
    } else {
      tab?.close();
    }
  } catch (caught) {
    tab?.close();
    throw caught;
  }
}

/** Asks the Assistant hub to open a task in the Tasks panel. */
export const OPEN_TASK_EVENT = "agentlink-assistant-open-task";

export function requestOpenTask(taskId: string): void {
  window.dispatchEvent(
    new CustomEvent<string>(OPEN_TASK_EVENT, { detail: taskId }),
  );
}

/**
 * Live cards for the open chat's coding tasks, above the composer. The
 * labels are the Tasks panel's, and the data comes with each snapshot, so
 * the card and the panel always agree. Opening one shows it in Tasks.
 */
export function ChatTaskStrip({
  tasks,
  onOpen = requestOpenTask,
  onEditor = taskEditorAction,
}: {
  tasks: readonly ChatTaskCard[] | undefined;
  onOpen?: (taskId: string) => void;
  onEditor?: (taskId: string, action: EditorAction) => Promise<void>;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  if (!tasks || tasks.length === 0) return null;
  const editor = (taskId: string, action: EditorAction) => {
    setProblem(null);
    onEditor(taskId, action).catch((caught: unknown) => {
      setProblem(errorText(caught));
    });
  };
  return (
    <ul class="assistant-chat-tasks" aria-label="Coding tasks from this chat">
      {tasks.map((task) => {
        const state = taskStateLabel(task.state);
        return (
          <li class="assistant-chat-task" key={task.id}>
            <i class="codicon codicon-git-pull-request" aria-hidden="true" />
            <button
              type="button"
              class="assistant-task-open"
              title="Open in Tasks"
              onClick={() => onOpen(task.id)}
            >
              <span class="assistant-chat-task-name">
                {taskName(task.objective)}
              </span>
              <span class="assistant-job-meta">
                <span class={`assistant-run-status tone-${state.tone}`}>
                  {state.label}
                </span>
                {" · "}
                {shortRepository(task.repository)}
              </span>
            </button>
            {task.pullRequest && (
              <a
                class="assistant-task-pr"
                href={task.pullRequest}
                target="_blank"
                rel="noreferrer"
              >
                Pull request
              </a>
            )}
            {task.state === "editing" && (
              <>
                <button
                  type="button"
                  class="assistant-task-pr"
                  onClick={() => editor(task.id, "open")}
                >
                  Open editor
                </button>
                <button
                  type="button"
                  class="assistant-task-pr"
                  onClick={() => editor(task.id, "hand_back")}
                >
                  Hand back
                </button>
              </>
            )}
          </li>
        );
      })}
      {problem && (
        <li class="assistant-project-error" role="alert">
          {problem}
        </li>
      )}
    </ul>
  );
}

/** `owner/name` for a GitHub URL, the URL otherwise. */
export function shortRepository(repository: string): string {
  return repository
    .replace(/^https:\/\/(github\.com\/)?/u, "")
    .replace(/\.git$/u, "");
}

/**
 * Whether the owner can publish this task now, and whether that means
 * publishing without a review. The server checks again and says why not.
 */
export function publishAction(
  task: Task,
  permitted: boolean,
): { label: string; allowUnreviewed: boolean } | undefined {
  if (!permitted || !task.headCommit) return undefined;
  const publishable =
    task.state === "ready" ||
    task.state === "blocked_review" ||
    (task.state === "published" && task.publishedCommit !== task.headCommit);
  if (!publishable) return undefined;
  if (!task.current.review) {
    return { label: "Publish without review", allowUnreviewed: true };
  }
  return {
    label: task.state === "published" ? "Update PR" : "Publish draft PR",
    allowUnreviewed: false,
  };
}

/** Why a ready task did not publish by itself, in the owner's words. */
export function notPublishedReason(
  task: Task,
  permitted: boolean,
): string | undefined {
  if (task.state !== "ready" && task.state !== "blocked_review") {
    return undefined;
  }
  if (task.state === "ready" && task.error) {
    return `Publishing failed: ${task.errorDetail ?? task.error}`;
  }
  if (!permitted) {
    return "Not published: this repository has no GitHub connection to publish with. Choose one under GitHub.";
  }
  if (!task.current.review) {
    return "Not published: no reviewer looked at this commit. You can publish it without a review.";
  }
  if (task.openFindings || task.current.review.verdict !== "approve") {
    return "Not published: the review still has blocking findings. Publish it yourself if they can wait.";
  }
  return undefined;
}

function short(commit: string | undefined): string {
  return commit ? commit.slice(0, 7) : "";
}

function formatWhen(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(ms: number): string {
  return ms < 1_000 ? `${ms} ms` : `${(ms / 1_000).toFixed(1)} s`;
}

type View =
  | { kind: "list" }
  | { kind: "task"; taskId: string }
  | {
      kind: "chat";
      taskId: string;
      projectId: string;
      sessionId: string;
      title: string;
    };

export function TasksPanel({
  revision,
  onClose,
  initialTaskId,
  openTaskChat,
}: {
  revision: number;
  onClose: () => void;
  /** Open this task's detail first (a link from the Inbox). */
  initialTaskId?: string;
  /**
   * Open a task's own chat in the chat list, where it can be written to and
   * stopped like any chat. Without it, the chat opens read-only here.
   */
  openTaskChat?: (projectId: string, sessionId: string) => void;
}) {
  const [view, setView] = useState<View>(
    initialTaskId ? { kind: "task", taskId: initialTaskId } : { kind: "list" },
  );

  if (view.kind === "chat") {
    return (
      <Dialog title={view.title} onClose={onClose} wide>
        <TaskChat
          projectId={view.projectId}
          sessionId={view.sessionId}
          revision={revision}
          onBack={() => setView({ kind: "task", taskId: view.taskId })}
        />
      </Dialog>
    );
  }
  if (view.kind === "task") {
    return (
      <TaskDetailView
        taskId={view.taskId}
        revision={revision}
        onClose={onClose}
        onBack={() => setView({ kind: "list" })}
        openTaskChat={openTaskChat}
        openChat={(projectId, sessionId, title) =>
          setView({
            kind: "chat",
            taskId: view.taskId,
            projectId,
            sessionId,
            title,
          })
        }
      />
    );
  }
  return (
    <TaskList
      revision={revision}
      onClose={onClose}
      openTask={(taskId) => setView({ kind: "task", taskId })}
    />
  );
}

function TaskList({
  revision,
  onClose,
  openTask,
}: {
  revision: number;
  onClose: () => void;
  openTask: (taskId: string) => void;
}) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    requestJson<{ tasks: Task[]; enabled: boolean }>("/api/tasks").then(
      (body) => {
        if (cancelled) return;
        setTasks(body.tasks);
        setEnabled(body.enabled);
      },
      (caught: unknown) => {
        if (!cancelled) setError(errorText(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [revision]);

  const matchesFilter = (task: Task, value: string) => {
    if (value === "active") return ACTIVE.includes(task.state);
    if (value === "attention")
      return ["warn", "bad"].includes(taskStateLabel(task.state).tone);
    if (value === "finished")
      return ["ready", "published", "cancelled"].includes(task.state);
    return true;
  };
  const visible = (tasks ?? [])
    .filter(
      (task) =>
        matchesFilter(task, filter) &&
        `${task.objective} ${task.repository} ${task.branch}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <Dialog title="Tasks" onClose={onClose} wide>
      <p class="assistant-panel-description">
        Follow coding work from the first change to the pull request. Open a
        task to review its checks or jump into its chat.
      </p>
      {tasks && tasks.length > 0 && (
        <div class="assistant-list-toolbar">
          <input
            type="search"
            class="assistant-list-search"
            aria-label="Search tasks"
            placeholder="Search tasks, repositories or branches…"
            value={query}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
          <div
            class="assistant-filter-bar"
            role="group"
            aria-label="Filter tasks"
          >
            {(
              [
                ["all", "All"],
                ["active", "Active"],
                ["attention", "Needs you"],
                ["finished", "Finished"],
              ] as const
            ).map(([value, label]) => (
              <button
                type="button"
                key={value}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {label}{" "}
                <span>
                  {tasks.filter((task) => matchesFilter(task, value)).length}
                </span>
              </button>
            ))}
          </div>
          <span class="assistant-job-meta" role="status">
            {visible.length} of {tasks.length} tasks
          </span>
        </div>
      )}
      {error && (
        <p class="assistant-project-error" role="alert">
          {error}
        </p>
      )}
      {!tasks ? (
        <p class="assistant-project-hint">{error ? "" : "Loading…"}</p>
      ) : tasks.length === 0 ? (
        <div class="assistant-panel-empty">
          <i class="codicon codicon-git-pull-request" aria-hidden="true" />
          <p>
            {enabled
              ? "No coding tasks yet. Ask in a chat to start one: give it a repository and what to change, and allow the card."
              : "Coding tasks need projectsRoot in the server's configuration."}
          </p>
        </div>
      ) : visible.length === 0 ? (
        <div class="assistant-panel-empty">
          <i class="codicon codicon-search" aria-hidden="true" />
          <strong>No matching tasks</strong>
          <p>Try another search or show all tasks.</p>
          <button
            type="button"
            class="assistant-panel-action"
            onClick={() => {
              setQuery("");
              setFilter("all");
            }}
          >
            Clear filters
          </button>
        </div>
      ) : (
        <ul class="assistant-job-list assistant-task-list">
          {visible.map((task) => {
            const state = taskStateLabel(task.state);
            return (
              <li class="assistant-job" key={task.id}>
                <button
                  type="button"
                  class="assistant-task-open"
                  onClick={() => openTask(task.id)}
                >
                  <span class="assistant-job-main">
                    <strong>{taskName(task.objective)}</strong>
                    <span class="assistant-job-meta">
                      <span class={`assistant-run-status tone-${state.tone}`}>
                        {state.label}
                      </span>
                      {" · "}
                      {shortRepository(task.repository)}
                      {" · "}
                      {formatWhen(task.updatedAt)}
                    </span>
                    <span class="assistant-job-meta">
                      <code>{task.branch}</code>
                    </span>
                  </span>
                </button>
                {task.pullRequest && (
                  <a
                    class="assistant-task-pr"
                    href={task.pullRequest.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <i
                      class="codicon codicon-git-pull-request"
                      aria-hidden="true"
                    />{" "}
                    #{task.pullRequest.number}
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}

function TaskDetailView({
  taskId,
  revision,
  onClose,
  onBack,
  openChat,
  openTaskChat,
}: {
  taskId: string;
  revision: number;
  onClose: () => void;
  onBack: () => void;
  openChat: (projectId: string, sessionId: string, title: string) => void;
  openTaskChat?: (projectId: string, sessionId: string) => void;
}) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloads, setReloads] = useState(0);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    requestJson<TaskDetail>(`/api/tasks/${encodeURIComponent(taskId)}`).then(
      (body) => {
        if (!cancelled) setDetail(body);
      },
      (caught: unknown) => {
        if (!cancelled) setError(errorText(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [taskId, revision, reloads]);

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setReloads((count) => count + 1);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };
  const post = (operation: string, body?: unknown) =>
    requestJson(
      `/api/tasks/${encodeURIComponent(taskId)}/${operation}`,
      body === undefined ? { method: "POST" } : { method: "POST", body },
    );

  const back = (
    <button type="button" class="assistant-panel-action" onClick={onBack}>
      <i class="codicon codicon-arrow-left" aria-hidden="true" /> All tasks
    </button>
  );

  if (gone) {
    return (
      <Dialog title="Task" onClose={onClose} wide actions={back}>
        <p class="assistant-project-hint">The task was deleted.</p>
      </Dialog>
    );
  }
  if (!detail) {
    return (
      <Dialog title="Task" onClose={onClose} wide actions={back}>
        {error ? (
          <p class="assistant-project-error" role="alert">
            {error}
          </p>
        ) : (
          <p class="assistant-project-hint">Loading…</p>
        )}
      </Dialog>
    );
  }

  const { task } = detail;
  const state = taskStateLabel(task.state);
  const permitted = detail.publish !== null;
  const publish = publishAction(task, permitted);
  const reason = notPublishedReason(task, permitted);
  const { validation, review } = task.current;
  const active = ACTIVE.includes(task.state);
  const editing = task.state === "editing";
  // The editor needs the task's chat and clone; the server checks again.
  const editorEnabled = detail.editor?.enabled === true && !!task.sessionId;

  return (
    <Dialog
      title={taskName(task.objective)}
      onClose={onClose}
      wide
      actions={back}
    >
      {error && (
        <p class="assistant-project-error" role="alert">
          {error}
        </p>
      )}
      <section class="assistant-task-summary">
        <p>
          <span class={`assistant-run-status tone-${state.tone}`}>
            {state.label}
          </span>
          {task.pullRequest && (
            <>
              {" · "}
              <a href={task.pullRequest.url} target="_blank" rel="noreferrer">
                Draft PR #{task.pullRequest.number}
              </a>
            </>
          )}
        </p>
        <dl class="assistant-task-facts">
          <dt>Repository</dt>
          <dd>
            <a href={task.repository} target="_blank" rel="noreferrer">
              {shortRepository(task.repository)}
            </a>
          </dd>
          {task.references && task.references.length > 0 && (
            <>
              <dt>Reads</dt>
              <dd>
                {task.references.map((reference, index) => (
                  <>
                    {index > 0 && ", "}
                    <a href={reference} target="_blank" rel="noreferrer">
                      {shortRepository(reference)}
                    </a>
                  </>
                ))}
              </dd>
            </>
          )}
          <dt>Branch</dt>
          <dd>
            <code>{task.branch}</code>
            {task.resolvedBaseBranch && <> from {task.resolvedBaseBranch}</>}
          </dd>
          {task.headCommit && (
            <>
              <dt>Commit</dt>
              <dd>
                <code>{short(task.headCommit)}</code>
                {task.commits && task.commits.length > 0 && (
                  <>
                    {" "}
                    ({task.commits.length} commit
                    {task.commits.length === 1 ? "" : "s"}
                    {task.fixRounds
                      ? `, ${task.fixRounds} fix round${task.fixRounds === 1 ? "" : "s"}`
                      : ""}
                    )
                  </>
                )}
              </dd>
            </>
          )}
        </dl>
        {(task.error || task.errorDetail) && task.state !== "ready" && (
          <p class="assistant-project-error">
            {task.errorDetail ?? task.error}
          </p>
        )}
        {reason && <p class="assistant-project-hint">{reason}</p>}
      </section>

      <div class="assistant-task-actions">
        {task.sessionId && openTaskChat && task.origin ? (
          <button
            type="button"
            onClick={() =>
              openTaskChat(task.origin!.projectId, task.sessionId!)
            }
          >
            <i class="codicon codicon-comment-discussion" aria-hidden="true" />{" "}
            Open chat
          </button>
        ) : (
          task.sessionId && (
            <button
              type="button"
              onClick={() =>
                openChat(task.projectId, task.sessionId!, "Implementation chat")
              }
            >
              <i
                class="codicon codicon-comment-discussion"
                aria-hidden="true"
              />{" "}
              Implementation chat
            </button>
          )
        )}
        {review && (
          <button
            type="button"
            onClick={() =>
              openChat(task.projectId, review.sessionId, "Review chat")
            }
          >
            <i class="codicon codicon-eye" aria-hidden="true" /> Review chat
          </button>
        )}
        {publish && (
          <button
            type="button"
            class="primary"
            disabled={busy}
            onClick={() =>
              void act(() =>
                post(
                  "publish",
                  publish.allowUnreviewed ? { allowUnreviewed: true } : {},
                ),
              )
            }
          >
            <i class="codicon codicon-git-pull-request" aria-hidden="true" />{" "}
            {publish.label}
          </button>
        )}
        {editorEnabled && (
          <button
            type="button"
            title={
              editing
                ? "Open the task's folder to edit it"
                : "Open the task's folder read-only"
            }
            disabled={busy}
            onClick={() => void act(() => taskEditorAction(taskId, "open"))}
          >
            <i class="codicon codicon-code" aria-hidden="true" /> Open editor
          </button>
        )}
        {editorEnabled && !editing && (
          <button
            type="button"
            title="Stop the task and edit its folder yourself"
            disabled={busy}
            onClick={() => {
              if (
                active &&
                !window.confirm(
                  "Take over this task? Its current turn stops until you hand it back.",
                )
              ) {
                return;
              }
              void act(() => taskEditorAction(taskId, "take_over"));
            }}
          >
            <i class="codicon codicon-edit" aria-hidden="true" /> Take over
          </button>
        )}
        {editing && (
          <button
            type="button"
            class="primary"
            title="Close the editor and let the task carry on with your changes"
            disabled={busy}
            onClick={() =>
              void act(() => taskEditorAction(taskId, "hand_back"))
            }
          >
            <i class="codicon codicon-debug-continue" aria-hidden="true" /> Hand
            back
          </button>
        )}
        {active && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act(() => post("stop"))}
          >
            <i class="codicon codicon-debug-stop" aria-hidden="true" /> Stop
          </button>
        )}
        {RESUMABLE.includes(task.state) && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act(() => post("resume"))}
          >
            <i class="codicon codicon-debug-continue" aria-hidden="true" />{" "}
            Resume
          </button>
        )}
        {!active && (
          <button
            type="button"
            class="danger"
            disabled={busy}
            onClick={() => {
              if (
                !window.confirm(
                  "Delete this task? Its clone and chats go; the branch and pull request on GitHub stay.",
                )
              ) {
                return;
              }
              void act(async () => {
                await requestJson(`/api/tasks/${encodeURIComponent(taskId)}`, {
                  method: "DELETE",
                });
                setGone(true);
              });
            }}
          >
            <i class="codicon codicon-trash" aria-hidden="true" /> Delete
          </button>
        )}
      </div>

      {task.summary && (
        <section class="assistant-inbox-group">
          <h3>Summary</h3>
          <p class="assistant-task-text">{task.summary}</p>
        </section>
      )}

      <section class="assistant-inbox-group">
        <h3>Validation</h3>
        {validation ? (
          <ul class="assistant-task-checks">
            {validation.commands.map((result, index) => {
              const passed = result.exitCode === 0 && !result.timedOut;
              return (
                <li key={index}>
                  <details>
                    <summary>
                      <i
                        class={`codicon codicon-${passed ? "pass" : "error"}`}
                        aria-label={passed ? "Passed" : "Failed"}
                      />{" "}
                      <code>{result.command}</code>{" "}
                      <span class="assistant-job-meta">
                        {result.timedOut
                          ? "timed out"
                          : passed
                            ? "passed"
                            : `exit ${result.exitCode ?? "signal"}`}
                        , {formatDuration(result.durationMs)}
                      </span>
                    </summary>
                    <pre>{result.outputTail || "(no output)"}</pre>
                  </details>
                </li>
              );
            })}
            {validation.changedFiles && (
              <li class="assistant-project-error">
                The commands changed tracked files: {validation.changedFiles}
              </li>
            )}
          </ul>
        ) : (
          <p class="assistant-project-hint">
            {detail.validation.length === 0
              ? "This repository has no validation commands (set them under GitHub)."
              : "Not run on this commit yet."}
          </p>
        )}
      </section>

      <section class="assistant-inbox-group">
        <h3>Review</h3>
        {review ? (
          <>
            <p>
              {review.verdict === "approve" ? "Approved" : "Changes requested"}{" "}
              by <code>{review.model}</code>
            </p>
            {review.findings.length > 0 && (
              <ul class="assistant-task-findings">
                {review.findings.map((finding, index) => (
                  <li key={index} class={`severity-${finding.severity}`}>
                    <strong>
                      {finding.severity === "blocking"
                        ? "Blocking"
                        : "Suggestion"}
                    </strong>
                    {finding.file && (
                      <>
                        {" "}
                        <code>
                          {finding.file}
                          {finding.line ? `:${finding.line}` : ""}
                        </code>
                      </>
                    )}
                    : {finding.reason}
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p class="assistant-project-hint">Not reviewed on this commit yet.</p>
        )}
      </section>

      <section class="assistant-inbox-group">
        <h3>History</h3>
        <ol class="assistant-task-events">
          {detail.events.map((event, index) => (
            <li key={index}>
              <time dateTime={new Date(event.at).toISOString()}>
                {formatWhen(event.at)}
              </time>{" "}
              {taskStateLabel(event.state).label}
              {event.error ? ` (${event.error})` : ""}
            </li>
          ))}
        </ol>
      </section>
    </Dialog>
  );
}

interface TranscriptEntry {
  kind: "user" | "assistant" | "tool";
  text?: string;
  toolName?: string;
  truncated?: boolean;
}

function TaskChat({
  projectId,
  sessionId,
  revision,
  onBack,
}: {
  projectId: string;
  sessionId: string;
  revision: number;
  onBack: () => void;
}) {
  const [transcript, setTranscript] = useState<{
    entries: TranscriptEntry[];
    omitted: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    requestJson<{
      transcript: { entries: TranscriptEntry[]; omitted: number };
    }>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`,
    ).then(
      (body) => {
        if (!cancelled) setTranscript(body.transcript);
      },
      (caught: unknown) => {
        if (!cancelled) setError(errorText(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, sessionId, revision]);

  return (
    <>
      <p>
        <button type="button" class="assistant-panel-action" onClick={onBack}>
          <i class="codicon codicon-arrow-left" aria-hidden="true" /> Back to
          the task
        </button>
      </p>
      {error && (
        <p class="assistant-project-error" role="alert">
          {error}
        </p>
      )}
      {!transcript ? (
        <p class="assistant-project-hint">{error ? "" : "Loading…"}</p>
      ) : (
        <ol class="assistant-task-transcript" aria-label="Chat">
          {transcript.omitted > 0 && (
            <li class="assistant-project-hint">
              {transcript.omitted} earlier messages not shown.
            </li>
          )}
          {transcript.entries.map((entry, index) =>
            entry.kind === "tool" ? (
              <li key={index} class="tool">
                <i class="codicon codicon-tools" aria-hidden="true" /> Used{" "}
                <code>{entry.toolName}</code>
              </li>
            ) : (
              <li key={index} class={entry.kind}>
                <strong>{entry.kind === "user" ? "Task" : "Assistant"}</strong>
                <p class="assistant-task-text">
                  {entry.text}
                  {entry.truncated ? "…" : ""}
                </p>
              </li>
            ),
          )}
        </ol>
      )}
    </>
  );
}
