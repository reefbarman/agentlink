import type { AgentMessage } from "./types.js";
import type { Checkpoint } from "./CheckpointManager.js";
import type { PendingQuestionRecoveryContext } from "../core/tools/types.js";
import type { Question } from "./webview/types.js";
import type { ReasoningEffort } from "./providers/types.js";
import type { SessionSummary } from "./SessionStore.js";

export type PersistenceRevision = string;

export interface SessionPersistenceIdentity {
  ownerId: string;
  surface: "vscode" | "cli" | "desktop" | "browser" | "core" | "test";
  startedAt: number;
}

export interface SessionRead<T> {
  value: T;
  revision: PersistenceRevision;
}

export type PersistResult =
  | { ok: true; revision: PersistenceRevision }
  | { ok: false; reason: "conflict"; currentRevision: PersistenceRevision }
  | { ok: false; reason: "not_owner"; owner?: SessionPersistenceIdentity }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "corrupt" | "io_error"; message: string };

export type SessionReadResult<T> =
  | ({ ok: true } & SessionRead<T>)
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "corrupt" | "io_error"; message: string };

export interface CheckpointState {
  baseCommit: string | null;
  checkpoints: Checkpoint[];
}

export interface RevertRecoveryState {
  checkpointId: string;
  sessionRevision: PersistenceRevision;
  workspaceRevision?: string;
  startedAt: number;
  reason: "workspace_reverted_session_save_failed";
}

export interface PendingQuestionRecoveryState extends PendingQuestionRecoveryContext {
  questionRequestId: string;
  context: string;
  questions: Question[];
}

export type PersistedSessionRunState =
  | {
      phase: "running";
      startedAt: number;
    }
  | {
      phase: "awaiting_question";
      startedAt: number;
      question: PendingQuestionRecoveryState;
    };

export type PersistedFleetLifecycle =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "budget_exhausted"
  | "paused"
  | "interrupted";

/** Durable execution identity for non-foreground fleet sessions. */
export interface PersistedFleetMetadata {
  schemaVersion: 1;
  placement: "background" | "worktree" | "remote";
  parentSessionId?: string;
  rootSessionId: string;
  task: string;
  depth: number;
  backend: "native" | `acp:${string}`;
  readonlyOnly?: boolean;
  resolvedMode: string;
  resolvedModel: string;
  resolvedProvider: string;
  taskClass: string;
  routingReason: string;
  fallbackUsed: boolean;
  lifecycle: PersistedFleetLifecycle;
  terminalReason?: string;
  completedAt?: number;
  finalResult?: string;
  goalId?: string;
  delegation?: {
    ownedPaths?: string[];
    forbiddenPaths?: string[];
    permissionProfile?: string;
    worktree?: "shared" | "isolated";
    expectedResult?: string;
  };
  budget?: {
    maxTokens?: number;
    maxToolCalls?: number;
    maxApiTurns?: number;
    maxElapsedMs?: number;
    maxEstimatedCostUsd?: number;
    estimatedCostPerMillionTokens?: number;
    warningThresholdRatio?: number;
    scope?: "session" | "subtree" | "goal";
  };
  budgetUsage?: {
    tokens: number;
    toolCalls: number;
    apiTurns: number;
    elapsedMs: number;
    estimatedCostUsd?: number;
  };
  budgetWarning?: { kind: string; ratio: number; emittedAt: number };
  archivedAt?: number;
  resumedFromSessionId?: string;
  eventSequence?: number;
  events?: Array<{
    id: string;
    sequence: number;
    type:
      | "queued"
      | "started"
      | "approval"
      | "question"
      | "budget_warning"
      | "completed"
      | "failed"
      | "cancelled"
      | "paused"
      | "resumed"
      | "detached";
    timestamp: number;
    summary: string;
    readAt?: number;
  }>;
}

export interface PersistedSessionMetadata {
  mode: string;
  model: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens?: number;
  totalCacheCreationTokens?: number;
  lastInputTokens?: number;
  lastCacheReadTokens?: number;
  reasoningEffort?: ReasoningEffort;
  loadedSkills?: string[];
  checkpointState?: CheckpointState;
  revertPending?: RevertRecoveryState;
  runState?: PersistedSessionRunState;
  fleet?: PersistedFleetMetadata;
}

export interface PersistedSessionRecord {
  summary: SessionSummary;
  messages: AgentMessage[];
  metadata: PersistedSessionMetadata;
}

export interface SessionPersistenceProvider {
  identity: SessionPersistenceIdentity;

  listSessions(): Promise<SessionRead<SessionSummary[]>>;
  readSession(
    sessionId: string,
  ): Promise<SessionReadResult<PersistedSessionRecord>>;
  saveSession(args: {
    session: PersistedSessionRecord;
    expectedRevision: PersistenceRevision | null;
  }): Promise<PersistResult>;
  renameSession(args: {
    sessionId: string;
    title: string;
    expectedRevision: PersistenceRevision;
  }): Promise<PersistResult>;
  deleteSession(args: {
    sessionId: string;
    expectedRevision: PersistenceRevision;
  }): Promise<PersistResult>;
}
