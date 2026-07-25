import type {
  TerminalApprovalPolicy,
  TerminalApprovalReviewer,
  TerminalCommandApprovalPolicySnapshot,
  TerminalExecutionPreset,
} from "../core/capabilities/terminal.js";

import type { AgentMessage } from "./types.js";
import type { BackgroundResultState } from "../core/capabilities/background.js";
import type { Checkpoint } from "./CheckpointManager.js";
import type { FleetResultEnvelope } from "./FleetWorkflows.js";
import type { PendingQuestionRecoveryContext } from "../core/tools/types.js";
import type { CoreModelToolResultBlock } from "../core/modelRuntime.js";
import type { Question } from "./webview/types.js";
import type { ReasoningEffort } from "./providers/types.js";
import type { SessionProjectScope } from "../core/workspaceProjects.js";
import type { SessionSummary } from "./SessionStore.js";

export type PersistenceRevision = string;

/**
 * Durability tier for a session save.
 *
 * - `durable` (the default): temp write + fsync + rename + directory fsync.
 *   Required at turn boundaries, runState transitions, and destructive ops.
 * - `checkpoint`: mid-turn snapshot — temp write + rename only, no fsync.
 *   Rename still guarantees a crash never leaves a torn file; power loss may
 *   drop the last few seconds of an in-flight turn, which was mid-stream
 *   anyway. Providers must upgrade a checkpoint-written transcript to durable
 *   before persisting a durable metadata revision that references it.
 */
export type PersistDurability = "checkpoint" | "durable";

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
  /** Project that owns both the checkpoint manager and every checkpoint entry. */
  projectId?: string;
  baseCommit: string | null;
  checkpoints: Checkpoint[];
}

export interface RevertRecoveryState {
  projectId?: string;
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

export interface PersistedPendingToolResult extends CoreModelToolResultBlock {
  mcpApprovalPromotion?: import("../shared/types.js").McpApprovalPromotionMeta;
  composeTrace?: import("../shared/composeTypes.js").ComposeTrace;
}

export interface PersistedPendingToolTurn {
  schemaVersion: 1;
  assistantMessage: AgentMessage;
  toolResults: PersistedPendingToolResult[];
}

export type PersistedSessionRunState =
  | {
      phase: "running";
      projectId?: string;
      startedAt: number;
      /**
       * Visible text received from the provider but not yet committed as an
       * assistant message. It is materialized during interrupted-run recovery.
       */
      partialAssistantText?: string;
      /**
       * A provider-complete assistant tool turn that is still dispatching.
       * Keeping it outside canonical history avoids exposing placeholder tool
       * results to live tools while still making the turn durable on reload.
       */
      pendingToolTurn?: PersistedPendingToolTurn;
    }
  | {
      phase: "awaiting_question";
      projectId?: string;
      startedAt: number;
      question: PendingQuestionRecoveryState;
      /** Original provider turn retained while the question UI is pending. */
      pendingToolTurn?: PersistedPendingToolTurn;
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
  projectId?: string;
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
  /** Durable classification of the final result or active run. */
  resultState?: BackgroundResultState;
  /** Bounded useful output retained when final structured output is unavailable. */
  partialResult?: string;
  /** Whether the provider/engine classified a failed run as retryable. */
  agentRetryable?: boolean;
  /** Timestamp when the terminal result was surfaced in the parent transcript. */
  resultAnnouncedAt?: number;
  goalId?: string;
  workflowId?: string;
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
  worktreeExchangeId?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  childSessionId?: string;
  structuredResult?: FleetResultEnvelope;
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
  policyAudit?: Array<{
    id: string;
    timestamp: number;
    decision: "allowed" | "denied" | "approval_requested";
    operation: string;
    reason: string;
    path?: string;
  }>;
}

export interface PersistedSessionMetadata {
  /**
   * Authoritative durable project identity. Optional only while reading records
   * created before project-scoped sessions were introduced.
   */
  projectScope?: SessionProjectScope;
  /** Persisted editor/resource context, validated against projectScope on restore. */
  activeContextResourceUri?: string;
  mode: string;
  model: string;
  /** Legacy bundled mode retained for backward compatibility and UI migration. */
  commandApprovalPolicy?: TerminalCommandApprovalPolicySnapshot;
  /** Independent Codex-style approval policy dimension. */
  approvalPolicy?: TerminalApprovalPolicy;
  /** Independent reviewer selection for approval requests. */
  approvalReviewer?: TerminalApprovalReviewer;
  /** Independent execution capability preset. */
  executionPreset?: TerminalExecutionPreset;
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
  /**
   * Monotonic counter bumped on every transcript mutation
   * (`AgentSession.transcriptRevision`). Providers compare it against the
   * last written value to skip re-serializing an unchanged transcript without
   * hashing the full history. Absent for legacy callers; providers must fall
   * back to content comparison.
   */
  transcriptRevision?: number;
  /**
   * Mode instruction blocks pinned to conversation positions when the session
   * uses conversation placement for mode content (foreground sessions). Kept
   * beside — never inside — `messages` so transcript-derived counting (turns,
   * titles, checkpoints) is unaffected.
   */
  modeInstructionAnchors?: Array<{
    userTurnOrdinal: number;
    mode: string;
    blockText: string;
  }>;
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
    /** Defaults to "durable" when omitted. */
    durability?: PersistDurability;
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
