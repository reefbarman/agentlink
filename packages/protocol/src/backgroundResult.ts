import type { CoreReasoningEffort } from "./modelCatalog.js";
import type { FleetResultEnvelope } from "./fleetResult.js";

export type BackgroundResultState =
  | "running"
  | "completed"
  | "incomplete_expected_result"
  | "failed"
  | "cancelled"
  | "budget_exhausted"
  | "interrupted"
  | "authorization_lost";

export type BackgroundAgentRuntimePhase =
  | "queued"
  | "waiting_for_provider"
  | "thinking"
  | "responding"
  | "executing_tool"
  | "awaiting_approval"
  | "awaiting_coordinator"
  | "retrying_provider"
  | "completed"
  | "failed"
  | "cancelled";

export interface BackgroundAgentBudgetUsage {
  tokens: number;
  toolCalls: number;
  apiTurns: number;
  elapsedMs: number;
}

/** Serialized background/fleet session summary projected to interactive surfaces. */
export interface BgSessionInfo {
  id: string;
  task: string;
  status:
    | "queued"
    | "streaming"
    | "tool_executing"
    | "awaiting_approval"
    | "idle"
    | "error"
    | "cancelled";
  /** Most recently started tool name (while streaming). */
  currentTool?: string;
  /** UI-ready status label selected from terminal or heuristic state. */
  displayStatus?: string;
  /** Source for displayStatus selection. */
  displayStatusSource?: "terminal" | "heuristic";
  /** Resolved execution mode after route selection. */
  resolvedMode?: string;
  /** Resolved model id after route selection. */
  resolvedModel?: string;
  /** Resolved provider id after route selection. */
  resolvedProvider?: string;
  /** Thinking level selected for the background session. */
  reasoningEffort?: CoreReasoningEffort;
  /** Background task class used for routing profile selection. */
  taskClass?: string;
  /** Human-readable reason for the selected route. */
  routingReason?: string;
  /** True when route fallback behavior was used. */
  fallbackUsed?: boolean;
  /** Durable fleet ancestry and execution identity. */
  parentSessionId?: string;
  rootSessionId?: string;
  goalId?: string;
  workflowId?: string;
  workspace?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  depth?: number;
  placement?: "background" | "worktree" | "remote";
  delegation?: {
    ownedPaths?: string[];
    forbiddenPaths?: string[];
    permissionProfile?: string;
    worktree?: "shared" | "isolated";
    expectedResult?: string;
  };
  backend?: string;
  capabilities?: {
    canRead: boolean;
    canWrite: boolean;
    canExecute: boolean;
    canUseMcp: boolean;
    canDelegate: boolean;
    limitationReason?: string;
  };
  lifecycle?:
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "budget_exhausted"
    | "paused"
    | "interrupted";
  terminalReason?: string;
  resultState?: BackgroundResultState;
  partialResult?: string;
  agentRetryable?: boolean;
  createdAt?: number;
  lastActiveAt?: number;
  /** Timestamp when execution left the fleet queue. */
  startedAt?: number;
  /** Timestamp of the latest provider, text, or tool progress event. */
  lastProgressAt?: number;
  /** Timestamp when the current runtime phase began. */
  phaseStartedAt?: number;
  /** Timestamp when the current provider request began, including scheduler wait. */
  requestStartedAt?: number;
  /** Current provider-request wall time at snapshot creation. */
  requestElapsedMs?: number;
  /** Scheduled provider retry time when phase is retrying_provider. */
  retryAt?: number;
  elapsedMs?: number;
  idleMs?: number;
  phase?: BackgroundAgentRuntimePhase;
  canSteer?: boolean;
  canKill?: boolean;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  toolCalls?: number;
  apiTurns?: number;
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
  attention?:
    | "approval"
    | "question"
    | "failed"
    | "interrupted"
    | "budget_warning";
  attentionEvent?: {
    id: string;
    kind:
      | "approval"
      | "question"
      | "completion"
      | "failure"
      | "interrupted"
      | "budget_warning";
    timestamp: number;
  };
  archivedAt?: number;
  unreadEventCount?: number;
  events?: Array<{
    id: string;
    sequence: number;
    type: string;
    timestamp: number;
    summary: string;
    readAt?: number;
  }>;
  policyAuditCount?: number;
  structuredResult?: FleetResultEnvelope;
  /** Accumulated streaming text from the bg agent (last ~500 chars for preview). */
  streamingText?: string;
  /** Error message if the agent errored. */
  errorMessage?: string;
  /** Timestamp when the agent finished (for auto-dismiss timing). */
  completedAt?: number;
}

export type BackgroundResultVisualFamily =
  | "success"
  | "warning"
  | "error"
  | "cancelled";

export interface BackgroundResultPresentation {
  family: BackgroundResultVisualFamily;
  icon: string;
  title: string;
  statusText: string;
  reason?: string;
}

function humanizeTerminalReason(
  reason: string | undefined,
): string | undefined {
  const trimmed = reason?.trim();
  if (!trimmed) return undefined;
  if (trimmed === "incomplete_expected_result") {
    return "The agent ended without returning the expected result format.";
  }
  if (trimmed === "extension_reloaded_during_run") {
    return "The extension reloaded while the background agent was running.";
  }
  if (trimmed === "outside_caller_subtree") {
    return "This session is no longer authorized to access that background result.";
  }
  if (trimmed === "background_session_not_found") {
    return "No loaded background session matches that id; the id may be mistyped, or the session was not restored with the current foreground session.";
  }
  if (trimmed === "cancelled_by_user") return "Cancelled by the user.";
  if (trimmed.startsWith("budget_exhausted:")) {
    return `The background agent reached its ${trimmed.slice("budget_exhausted:".length).replaceAll("_", " ")} budget.`;
  }
  return trimmed.replaceAll("_", " ");
}

export function getBackgroundResultPresentation(
  resultState: BackgroundResultState | undefined,
  legacyStatus: "completed" | "error" | "cancelled",
  terminalReason?: string,
): BackgroundResultPresentation {
  const state =
    resultState ??
    (legacyStatus === "completed"
      ? "completed"
      : legacyStatus === "cancelled"
        ? "cancelled"
        : "failed");
  const reason = humanizeTerminalReason(terminalReason);
  switch (state) {
    case "completed":
      return {
        family: "success",
        icon: "codicon-check",
        title: "Background Result",
        statusText: "completed",
      };
    case "incomplete_expected_result":
      return {
        family: "warning",
        icon: "codicon-warning",
        title: "Incomplete Result",
        statusText: "expected result missing",
        reason:
          reason ??
          "The agent ended without returning the expected result format.",
      };
    case "budget_exhausted":
      return {
        family: "warning",
        icon: "codicon-warning",
        title: "Background Stopped",
        statusText: "budget exhausted",
        reason: reason ?? "The background agent reached its budget.",
      };
    case "interrupted":
      return {
        family: "warning",
        icon: "codicon-warning",
        title: "Background Interrupted",
        statusText: "interrupted",
        reason,
      };
    case "authorization_lost":
      return {
        family: "error",
        icon: "codicon-error",
        title: "Background Failed",
        statusText: "authorization lost",
        reason,
      };
    case "cancelled":
      return {
        family: "cancelled",
        icon: "codicon-circle-slash",
        title: "Background Cancelled",
        statusText: "cancelled",
        reason,
      };
    case "running":
    case "failed":
    default:
      return {
        family: "error",
        icon: "codicon-error",
        title: "Background Failed",
        statusText: "failed",
        reason,
      };
  }
}
