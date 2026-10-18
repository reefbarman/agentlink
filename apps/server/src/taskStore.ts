import { HttpError } from "./httpJson.js";
import { promises as fs } from "node:fs";
import { parseGitHubRepository } from "./githubApi.js";
import path from "node:path";
import { planRepositories } from "./projectCatalog.js";
import { randomBytes } from "node:crypto";
import { writeFileAtomic } from "./atomicFile.js";
import {
  ACTIVE_TASK_STATES,
  RESUMABLE_TASK_STATES,
  type TaskCurrentEvidence,
  type TaskEvidence,
  type TaskState,
} from "../../../src/shared/assistantTasks.js";

/**
 * Coding tasks: one record per task, kept in memory and persisted under
 * `<dataRoot>/tasks/`: `tasks.json` (every record, replaced atomically on
 * each change) and `events.jsonl` (every state change, appended, never
 * rewritten except to drop a deleted task's lines). One server process
 * holds the data root, so nothing else writes here.
 */

export const MAX_TASKS = 200;
export const MAX_OBJECTIVE_LENGTH = 20_000;
const MAX_BRANCH_LENGTH = 200;
const MODEL_KEY_PATTERN = /^[^/\s]{1,128}\/[^\s]{1,256}$/u;
export const TASK_ID_PATTERN = /^[0-9a-f]{12}$/u;
/** Every branch a task creates or pushes starts with this. */
export const TASK_BRANCH_PREFIX = "agentlink/";

// The states, evidence and wire shapes are shared with the browser UI.
export {
  ACTIVE_TASK_STATES,
  RESUMABLE_TASK_STATES,
  TASK_STATES,
} from "../../../src/shared/assistantTasks.js";
export type {
  ReviewFinding,
  TaskEvidence,
  TaskState,
  ValidationCommandResult,
} from "../../../src/shared/assistantTasks.js";

export interface TaskRequest {
  /** `https://` clone URL, without credentials. */
  readonly repository: string;
  /** Branch to start from; the repository's default branch when absent. */
  readonly baseBranch?: string;
  /** What the task should achieve, as the owner gave it. */
  readonly objective: string;
  /** `providerId/modelId`; the server's default model when absent. */
  readonly model?: string;
  /**
   * GitHub repositories the task may read (at most 3), as
   * `https://github.com/<owner>/<name>`: cloned at their default branch
   * head into `<task folder>/refs/<owner>/<name>`, never changed or pushed.
   */
  readonly references?: readonly string[];
}

/** Reference repositories a task may have. */
export const MAX_TASK_REFERENCES = 3;
/** The task folder's subfolder holding reference clones. */
export const TASK_REFERENCES_FOLDER = "refs";

/** The latest evidence of each kind for exactly this commit. */
export function evidenceFor(
  task: Pick<TaskRun, "evidence">,
  commit: string | undefined,
): TaskCurrentEvidence {
  const latest = <K extends TaskEvidence["kind"]>(kind: K) =>
    commit === undefined
      ? undefined
      : ([...task.evidence]
          .reverse()
          .find(
            (entry: TaskEvidence) =>
              entry.kind === kind && entry.commit === commit,
          ) as Extract<TaskEvidence, { kind: K }> | undefined);
  const implementation = latest("implementation");
  const validation = latest("validation");
  const review = latest("review");
  return {
    ...(implementation ? { implementation } : {}),
    ...(validation ? { validation } : {}),
    ...(review ? { review } : {}),
  };
}

/**
 * An external effect recorded before it is made, so a restart can check
 * what happened instead of repeating it. `intended` with no outcome after a
 * restart means the publisher must look before acting again.
 */
export interface TaskEffectIntent {
  readonly kind: "push" | "pull_request";
  readonly commit: string;
  readonly status: "intended" | "done" | "failed";
  readonly at: number;
  readonly url?: string;
  /** The stable error code when it failed. */
  readonly error?: string;
}

export interface TaskRun extends TaskRequest {
  readonly id: string;
  /** The task's hidden project: its own host, mounted only for the owner. */
  readonly projectId: string;
  /** `agentlink/<slug>-<id>`. */
  readonly branch: string;
  /** The clone the task works in; nothing else uses it. */
  readonly workspace: string;
  readonly state: TaskState;
  /** Set once the workspace is cloned and on the task branch. */
  readonly baseCommit?: string;
  /** The branch the clone started from, once known. */
  readonly resolvedBaseBranch?: string;
  /** Implementation turns started, including follow-ups. */
  readonly attempts: number;
  /** Rounds spent fixing failed validation or review findings. */
  readonly fixRounds?: number;
  /** Blocking review findings still open when the task became ready. */
  readonly openFindings?: number;
  /** The implementation chat. */
  readonly sessionId?: string;
  /** The task branch's commit when the chat last finished. */
  readonly headCommit?: string;
  /** `baseCommit..headCommit`, oldest first. */
  readonly commits?: readonly string[];
  readonly evidence: readonly TaskEvidence[];
  readonly effects: readonly TaskEffectIntent[];
  /**
   * The GitHub connection whose person the commits credit, fixed when the
   * clone was made. It publishes with that connection only.
   */
  readonly connectionId?: string;
  /** The draft pull request, once opened. */
  readonly pullRequest?: { readonly number: number; readonly url: string };
  /** The commit last pushed to the task branch. */
  readonly publishedCommit?: string;
  /** The chat's final message, shortened. */
  readonly summary?: string;
  /** A stable error code. */
  readonly error?: string;
  /** What actually went wrong, in words, when it is known. */
  readonly errorDetail?: string;
  /**
   * The chat that started the task (or asked its latest follow-up): its
   * outcomes are delivered there.
   */
  readonly origin?: { readonly projectId: string; readonly sessionId: string };
  /**
   * "Work here": the origin chat shows this work live and takes the owner's
   * messages for it while it is active. Otherwise it is a separate work
   * session whose outcome comes back to the origin chat.
   */
  readonly here?: boolean;
  /** The owner's follow-up instructions, oldest first (`continue_task`). */
  readonly followUps?: readonly TaskFollowUp[];
  /** A follow-up approved but not yet sent to the implementation chat. */
  readonly pendingFollowUp?: string;
  /** While `editing`: when the owner took over, and the head then. */
  readonly takeover?: { readonly at: number; readonly head: string };
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startedAt?: number;
  readonly finishedAt?: number;
}

export interface TaskFollowUp {
  readonly instructions: string;
  readonly at: number;
}

/** Longest follow-up instruction from a chat. */
export const MAX_FOLLOW_UP_LENGTH = 4_000;
/** Follow-ups kept on a task. */
export const MAX_FOLLOW_UPS = 20;

export interface TaskEvent {
  readonly taskId: string;
  readonly at: number;
  readonly state: TaskState;
  readonly error?: string;
}

export class TaskInputError extends HttpError {
  constructor(code: string, status = 400) {
    super(status, code);
    this.name = "TaskInputError";
  }
}

export interface TaskStore {
  /** Newest first. */
  list(): readonly TaskRun[];
  get(taskId: string): TaskRun | undefined;
  /** Store a new task; its ID must be unused. */
  create(task: TaskRun): Promise<TaskRun>;
  /** Replace a task's record; a state change is also appended as an event. */
  save(task: TaskRun): Promise<void>;
  delete(taskId: string): Promise<boolean>;
  /** Oldest first. */
  events(taskId: string): readonly TaskEvent[];
  flush(): Promise<void>;
}

interface StoredTasks {
  readonly schemaVersion: 1;
  readonly tasks: readonly TaskRun[];
}

/** Validate a task request from an untrusted body. Unknown keys are refused. */
export function parseTaskRequest(body: Record<string, unknown>): TaskRequest {
  const known = new Set([
    "repository",
    "baseBranch",
    "objective",
    "model",
    "references",
  ]);
  if (Object.keys(body).some((key) => !known.has(key))) {
    throw new TaskInputError("task_field_unknown");
  }
  if (typeof body.repository !== "string") {
    throw new TaskInputError("repository_required");
  }
  // Same rules as a project's clone URL: https, no credentials.
  const [planned] = planRepositories([body.repository]);
  const objective = body.objective;
  if (typeof objective !== "string" || !objective.trim()) {
    throw new TaskInputError("objective_required");
  }
  if (objective.length > MAX_OBJECTIVE_LENGTH) {
    throw new TaskInputError("objective_too_long");
  }
  const request: {
    repository: string;
    objective: string;
    baseBranch?: string;
    model?: string;
    references?: string[];
  } = { repository: planned!.url, objective: objective.trim() };
  if (body.baseBranch !== undefined && body.baseBranch !== "") {
    if (
      typeof body.baseBranch !== "string" ||
      !isSafeBranchName(body.baseBranch)
    ) {
      throw new TaskInputError("base_branch_invalid");
    }
    request.baseBranch = body.baseBranch;
  }
  if (body.model !== undefined) {
    if (typeof body.model !== "string" || !MODEL_KEY_PATTERN.test(body.model)) {
      throw new TaskInputError("model_invalid");
    }
    request.model = body.model;
  }
  if (body.references !== undefined) {
    if (!Array.isArray(body.references)) {
      throw new TaskInputError("references_invalid");
    }
    if (body.references.length > MAX_TASK_REFERENCES) {
      throw new TaskInputError("references_too_many");
    }
    const target = parseGitHubRepository(request.repository);
    const references: string[] = [];
    for (const value of body.references) {
      const parsed =
        typeof value === "string" ? parseGitHubRepository(value) : undefined;
      if (!parsed) throw new TaskInputError("reference_invalid");
      const url = `https://github.com/${parsed.owner}/${parsed.name}`;
      const key = url.toLowerCase();
      if (
        (target &&
          key ===
            `https://github.com/${target.owner}/${target.name}`.toLowerCase()) ||
        references.some((existing) => existing.toLowerCase() === key)
      ) {
        throw new TaskInputError("reference_duplicate");
      }
      references.push(url);
    }
    // The target's own folder would hold the references otherwise.
    if (
      references.length > 0 &&
      planned!.directory === TASK_REFERENCES_FOLDER
    ) {
      throw new TaskInputError("repository_folder_conflict");
    }
    if (references.length > 0) request.references = references;
  }
  return request;
}

/** Where a reference is cloned, relative to the task folder. */
export function referenceFolder(reference: string): string {
  const parsed = parseGitHubRepository(reference);
  if (!parsed) throw new TaskInputError("reference_invalid");
  return path.join(TASK_REFERENCES_FOLDER, parsed.owner, parsed.name);
}

/**
 * A branch name git accepts that cannot be read as an option or a range:
 * the rules of `git check-ref-format --branch`, conservatively.
 */
export function isSafeBranchName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= MAX_BRANCH_LENGTH &&
    /^[A-Za-z0-9._/-]+$/u.test(name) &&
    !name.startsWith("-") &&
    !name.startsWith("/") &&
    !name.endsWith("/") &&
    !name.endsWith(".") &&
    !name.endsWith(".lock") &&
    !name.includes("..") &&
    !name.includes("//") &&
    !name.split("/").some((part) => part.startsWith("."))
  );
}

export function newTaskId(): string {
  return randomBytes(6).toString("hex");
}

/** `agentlink/<a-few-words-of-the-objective>-<id>`. */
export function taskBranchName(objective: string, taskId: string): string {
  const words = objective
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
  // Whole words only, up to 40 characters.
  let slug = "";
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > 40) break;
    slug = next;
  }
  return `${TASK_BRANCH_PREFIX}${slug || "task"}-${taskId}`;
}

export function isActiveTask(task: Pick<TaskRun, "state">): boolean {
  return ACTIVE_TASK_STATES.includes(task.state);
}

export function isResumableTask(task: Pick<TaskRun, "state">): boolean {
  return RESUMABLE_TASK_STATES.includes(task.state);
}

/**
 * Load the task store. A missing directory is an empty store; an unreadable
 * `tasks.json` stops the server rather than silently dropping tasks and
 * their workspaces. Torn event lines (a crash mid-append) are skipped.
 */
export async function openTaskStore(options: {
  readonly directory: string;
}): Promise<TaskStore> {
  const tasksFile = path.join(options.directory, "tasks.json");
  const eventsFile = path.join(options.directory, "events.jsonl");
  const tasks = new Map<string, TaskRun>();
  for (const task of await readTasks(tasksFile)) tasks.set(task.id, task);
  const events = new Map<string, TaskEvent[]>();
  for (const event of await readEvents(eventsFile)) {
    if (!tasks.has(event.taskId)) continue;
    const list = events.get(event.taskId) ?? [];
    list.push(event);
    events.set(event.taskId, list);
  }

  let writes: Promise<void> = Promise.resolve();
  const enqueue = (write: () => Promise<void>): Promise<void> => {
    const next = writes.then(async () => {
      await fs.mkdir(options.directory, { recursive: true, mode: 0o700 });
      await write();
    });
    writes = next.catch(() => undefined);
    return next;
  };
  const persist = () => {
    const content: StoredTasks = {
      schemaVersion: 1,
      tasks: [...tasks.values()],
    };
    return enqueue(() =>
      writeFileAtomic(tasksFile, `${JSON.stringify(content, null, 2)}\n`),
    );
  };
  const appendEvent = (task: TaskRun) => {
    const event: TaskEvent = {
      taskId: task.id,
      at: task.updatedAt,
      state: task.state,
      ...(task.error ? { error: task.error } : {}),
    };
    const list = events.get(task.id) ?? [];
    list.push(event);
    events.set(task.id, list);
    return enqueue(() =>
      fs.appendFile(eventsFile, `${JSON.stringify(event)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      }),
    );
  };

  return {
    list: () =>
      [...tasks.values()].sort(
        (left, right) => right.createdAt - left.createdAt,
      ),
    get: (taskId) => tasks.get(taskId),
    async create(task) {
      if (tasks.has(task.id)) throw new TaskInputError("task_exists", 409);
      if (tasks.size >= MAX_TASKS) {
        throw new TaskInputError("task_limit_reached", 409);
      }
      // Record and event change together, before any write is awaited.
      tasks.set(task.id, task);
      const written = Promise.all([persist(), appendEvent(task)]);
      await written;
      return task;
    },
    async save(task) {
      const previous = tasks.get(task.id);
      // A deleted task is not recorded again.
      if (!previous) return;
      tasks.set(task.id, task);
      await Promise.all([
        persist(),
        ...(previous.state !== task.state ? [appendEvent(task)] : []),
      ]);
    },
    async delete(taskId) {
      if (!tasks.delete(taskId)) return false;
      events.delete(taskId);
      await persist();
      await enqueue(() =>
        writeFileAtomic(
          eventsFile,
          [...events.values()]
            .flat()
            .map((event) => `${JSON.stringify(event)}\n`)
            .join(""),
        ),
      );
      return true;
    },
    events: (taskId) => [...(events.get(taskId) ?? [])],
    async flush() {
      await writes;
    },
  };
}

async function readTasks(file: string): Promise<TaskRun[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let parsed: Partial<StoredTasks> | undefined;
  try {
    parsed = JSON.parse(raw) as Partial<StoredTasks>;
  } catch {
    parsed = undefined;
  }
  if (
    !parsed ||
    parsed.schemaVersion !== 1 ||
    !Array.isArray(parsed.tasks) ||
    !parsed.tasks.every(isStoredTask)
  ) {
    throw new Error(
      `Tasks are unreadable: ${file}. Fix or remove it (removing forgets every task; their workspaces stay on disk).`,
    );
  }
  return [...parsed.tasks];
}

function isStoredTask(value: unknown): value is TaskRun {
  if (!value || typeof value !== "object") return false;
  const task = value as Record<string, unknown>;
  return (
    typeof task.id === "string" &&
    TASK_ID_PATTERN.test(task.id) &&
    typeof task.projectId === "string" &&
    typeof task.repository === "string" &&
    typeof task.objective === "string" &&
    typeof task.branch === "string" &&
    task.branch.startsWith(TASK_BRANCH_PREFIX) &&
    typeof task.workspace === "string" &&
    path.isAbsolute(task.workspace) &&
    typeof task.state === "string" &&
    typeof task.attempts === "number" &&
    Array.isArray(task.evidence) &&
    Array.isArray(task.effects) &&
    typeof task.createdAt === "number" &&
    typeof task.updatedAt === "number" &&
    (task.references === undefined ||
      (Array.isArray(task.references) &&
        task.references.every((reference) => typeof reference === "string")))
  );
}

async function readEvents(file: string): Promise<TaskEvent[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const events: TaskEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as TaskEvent;
      if (typeof event.taskId === "string" && typeof event.state === "string") {
        events.push(event);
      }
    } catch {
      // A torn final line from a crash mid-append.
    }
  }
  return events;
}
