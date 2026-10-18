/**
 * The coding-task wire contract between the AgentLink Assistant server and
 * its browser UI: the task states, which of them are active or resumable,
 * and the shapes `/api/tasks` and chat snapshots send. Browser-safe (types
 * and constants only). The server keeps persistence details (workspace,
 * effects, follow-ups) to itself; the browser keeps presentation (labels,
 * tones) to itself, and both type-check against these.
 */

export const TASK_STATES = [
  "queued",
  "preparing",
  "implementing",
  /** The implementation chat is waiting for the owner. */
  "awaiting_approval",
  /** The server is running the repository's validation commands. */
  "validating",
  /** A reviewer on another provider is reading the change. */
  "reviewing",
  /** The implementation chat is fixing failed checks or review findings. */
  "fixing",
  /** No reviewer could review the change (none configured, or it failed). */
  "blocked_review",
  /** Committed on the task branch with a clean tree. */
  "ready",
  /** Pushing the branch and opening its draft pull request. */
  "publishing",
  /** Pushed, with a draft pull request open. */
  "published",
  "failed",
  "cancelled",
  /** The server stopped while it worked; the workspace is kept. */
  "interrupted",
  /** The model provider's sign-in has expired or is missing. */
  "blocked_auth",
  /** The model provider refused for rate or subscription limits. */
  "blocked_quota",
  /**
   * The owner took the folder over in the editor: the task does not work,
   * resume or publish until it is handed back.
   */
  "editing",
] as const;

export type TaskState = (typeof TASK_STATES)[number];

/** States the runner owns: the task is queued or working. */
export const ACTIVE_TASK_STATES: readonly TaskState[] = [
  "queued",
  "preparing",
  "implementing",
  "awaiting_approval",
  "validating",
  "reviewing",
  "fixing",
  "publishing",
];

/** States a task can be resumed from. */
export const RESUMABLE_TASK_STATES: readonly TaskState[] = [
  "failed",
  "cancelled",
  "interrupted",
  "blocked_auth",
  "blocked_quota",
  "blocked_review",
];

/** One validation command's run, against the evidence's commit. */
export interface ValidationCommandResult {
  readonly command: string;
  /** Undefined (absent on the wire) when it was stopped by a signal. */
  readonly exitCode?: number | undefined;
  readonly timedOut: boolean;
  readonly durationMs: number;
  /** The end of its output. */
  readonly outputTail: string;
}

export interface ReviewFinding {
  readonly severity: "blocking" | "suggestion";
  readonly file?: string;
  readonly line?: number;
  readonly reason: string;
}

/**
 * Proof recorded against one exact commit. Evidence for any other commit
 * says nothing about the current one: a later commit makes it stale.
 */
export type TaskEvidence =
  | {
      /** The chat finished with this commit and a clean tree. */
      readonly kind: "implementation";
      readonly commit: string;
      readonly at: number;
    }
  | {
      /** The server ran the repository's validation commands. */
      readonly kind: "validation";
      readonly commit: string;
      readonly at: number;
      readonly passed: boolean;
      readonly commands: readonly ValidationCommandResult[];
      /** Files the commands changed (restored afterwards); fails the run. */
      readonly changedFiles?: string;
    }
  | {
      /** A reviewer on another provider read `baseCommit..commit`. */
      readonly kind: "review";
      readonly commit: string;
      readonly at: number;
      /** `providerId/modelId`. */
      readonly model: string;
      readonly sessionId: string;
      readonly verdict: "approve" | "changes_requested";
      readonly findings: readonly ReviewFinding[];
    };

/** The latest evidence of each kind for one commit. */
export interface TaskCurrentEvidence {
  readonly implementation?: Extract<TaskEvidence, { kind: "implementation" }>;
  readonly validation?: Extract<TaskEvidence, { kind: "validation" }>;
  readonly review?: Extract<TaskEvidence, { kind: "review" }>;
}

/** A task as `/api/tasks` describes it. */
export interface AssistantTaskWire {
  readonly id: string;
  /** The task's hidden project. */
  readonly projectId: string;
  readonly repository: string;
  readonly objective: string;
  readonly branch: string;
  readonly state: TaskState;
  readonly baseBranch?: string;
  readonly resolvedBaseBranch?: string;
  /** Repositories the task reads, read-only. */
  readonly references?: readonly string[];
  readonly baseCommit?: string;
  readonly headCommit?: string;
  readonly commits?: readonly string[];
  readonly fixRounds?: number;
  readonly openFindings?: number;
  /** The implementation chat. */
  readonly sessionId?: string;
  /** The chat that started the task; its own chat is listed beside it. */
  readonly origin?: { readonly projectId: string; readonly sessionId: string };
  readonly pullRequest?: { readonly number: number; readonly url: string };
  readonly publishedCommit?: string;
  readonly summary?: string;
  /** A stable error code. */
  readonly error?: string;
  readonly errorDetail?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly finishedAt?: number;
  /** Evidence for `headCommit`. */
  readonly current: TaskCurrentEvidence;
}

/** `GET /api/tasks/:id`. */
export interface AssistantTaskDetailWire {
  readonly task: AssistantTaskWire;
  readonly events: readonly {
    readonly at: number;
    readonly state: TaskState;
    readonly error?: string;
  }[];
  /** The repository's validation commands now. */
  readonly validation: readonly string[];
  /** The repository's publish permission, if any. */
  readonly publish: {
    readonly connectionId: string;
    readonly grantedAt: number;
  } | null;
  /** The browser editor: available, and open now (`ro` or `rw`). */
  readonly editor?: { readonly enabled: boolean; readonly mode?: "ro" | "rw" };
}

/** A coding task as the chat that started it shows it (snapshot `tasks`). */
export interface ChatTaskCard {
  readonly id: string;
  readonly state: TaskState;
  readonly objective: string;
  readonly repository: string;
  /** The draft pull request's URL. */
  readonly pullRequest?: string;
  readonly updatedAt: number;
}
